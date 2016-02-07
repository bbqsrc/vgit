/*!
 * Copyright (c)  2016 Brendan Molloy <brendan@bbqsrc.net>
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 * list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 * this list of conditions and the following disclaimer in the documentation and/or
 * other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
 * ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

'use strict';

const Git = require('nodegit'),
      Promise = require('bluebird'),
      fs = Promise.promisifyAll(require('fs')),
      koa = require('koa'),
      path = require('path'),
      Router = require('koa-rutt'),
      hbs = require('koa-hbs'),
      send = require('koa-send'),
      marky = require('marky-markdown'),
      moment = require('moment'),
      config = require('./config'),
      app = koa(),
      logger = require('koa-huggare'),
      Log = require('huggare-log'),
      router = new Router();

const TAG = 'vgit';

app.use(logger({
  exclude: /^\/static/ // Exclude based on tag param (optional)
}));

function routeStatic(router, prefix, root) {
  router.get(`${prefix}/:staticPath(.+)`, function* sendStatic() {
    yield send(this, this.params.staticPath, { root });
  });
}

const PATH = config.path;

app.use(hbs.middleware({
  defaultLayout: 'default',
  viewPath: path.join(__dirname, 'templates')
}));

function genPath(ctx, root, type) {
  const ref = root.ref.shorthand();
  const filename = path.basename(ctx.path());
  const basePath = (root.basePath || []).join('/');

  return path.join(`/${root.repoName}/${type}/${ref}`, basePath, filename);
}

hbs.registerHelper('blob', function(options) {
  return genPath(this, options.data.root, 'blob');
});

hbs.registerHelper('tree', function(options) {
  return genPath(this, options.data.root, 'tree');
});

hbs.registerHelper('breadcrumb', function(options) {
  const root = options.data.root;
  const ref = root.ref.shorthand();
  const basePath = root.basePath;
  const index = options.data.index;

  const p = basePath.slice(0, index + 1).join('/');

  if (options.hash.mode === 'blob' && options.data.last) {
    return path.join(`/${root.repoName}/blob/${ref}`, p);
  }
  return path.join(`/${root.repoName}/tree/${ref}`, p);
});

function getBranches(refs) {
  return refs.filter(r => r.isBranch()).map(r => r.shorthand());
}

function* parseReferenceFromPath(repo, param) {
  const refs = yield repo.getReferences(Git.Reference.TYPE.LISTALL);

  for (const ref of refs) {
    const sh = ref.shorthand();
    if (param.startsWith(sh)) {
      return { ref, path: param.substring(sh.length + 1) };
    }
  }

  return null;
}

function* appendEntryHistory(entries, repo, rpath) {
  for (const entry of entries) {
    if (entry.isDirectory()) {
      continue;
    }

    const fpath = path.join(rpath || '', path.basename(entry.path()));
    const blame = yield Git.Blame.file(repo, fpath);
    const count = blame.getHunkCount();
    const commits = [];

    for (let i = 0; i < count; ++i) {
      const hunk = blame.getHunkByIndex(i);
      commits.push(yield Git.Commit.lookup(repo, hunk.finalCommitId()));
    }

    commits.sort((a, b) => {
      return a.date() < b.date() ? -1 : 1;
    });

    const commit = commits.pop();
    commit.dateHuman = moment(commit.date()).fromNow();
    commit.messageProp = commit.message();
    entry.commit = commit;
  }

  return entries;
}

routeStatic(router, '/static',
  path.join(__dirname, 'node_modules/bootstrap/dist'));

router
.get('/', function* getIndex() {
  const files = yield fs.readdirAsync(PATH);
  const flags = Git.Repository.OPEN_FLAG.OPEN_NO_SEARCH |
                Git.Repository.OPEN_FLAG.OPEN_CROSS_FS;

  const repos = [];

  for (const fn of files) {
    const fpath = path.join(PATH, fn);

    try {
      const repo = yield Git.Repository.openExt(fpath, flags, PATH);
      if (repo) {
        repo.name = fn;
        repo.description = yield fs.readFileAsync(
            path.join(repo.path(), 'description'), 'utf-8');

        // Get last commit
        const commit = yield repo.getHeadCommit();

        repo.lastCommitObj = moment(commit.timeMs());
        repo.lastCommit = repo.lastCommitObj.fromNow();

        repos.push(repo);
      }
    } catch (e) {
      Log.v(TAG, 'Reading index:', e);
    }
  }

  repos.sort((a, b) => {
    return a.lastCommitObj.isAfter(b.lastCommitObj) ? -1 : 1;
  })

  yield this.render('index', { repos });
})
.get('/:repo', function* getRepo() {
  const repoPath = path.join(PATH, this.params.repo);
  const repo = yield Git.Repository.open(repoPath);

  const commit = yield repo.getMasterCommit();
  const ref = yield repo.getReference('heads/master');
  const tree = yield commit.getTree();

  const entries = yield appendEntryHistory(tree.entries(), repo);
  const directories = entries.filter(entry => entry.isDirectory());
  const files = entries.filter(entry => !entry.isDirectory());

  const readmeEntry = files.find(entry => {
    const name = path.basename(entry.path()).toLowerCase();
    return name.startsWith('readme');
  });

  let readme = null;
  if (readmeEntry) {
    const readmeBlob = yield readmeEntry.getBlob();
    readme = marky(readmeBlob.toString()).html();
  }

  yield this.render('tree', {
    repoName: this.params.repo,
    ref: ref,
    readme, tree, files, directories
  });
})
.get('/:repo/tree/:path(.*)', function* getRepoTree() {
  const repoPath = path.join(PATH, this.params.repo);
  const repo = yield Git.Repository.open(repoPath);

  const res = yield parseReferenceFromPath(repo, this.params.path);
  const commit = yield repo.getReferenceCommit(res.ref);

  let tree = yield commit.getTree();
  if (res.path !== "") {
    const entry = yield tree.entryByPath(res.path);
    // &wtf;
    entry.parent = tree;
    tree = yield entry.getTree();
  }

  const entries = yield appendEntryHistory(tree.entries(), repo, res.path);
  const directories = entries.filter(entry => entry.isDirectory());
  const files = entries.filter(entry => !entry.isDirectory());

  const readmeEntry = files.find(entry => {
    const name = path.basename(entry.path()).toLowerCase();
    return name.startsWith('readme');
  });

  let readme = null;
  if (readmeEntry) {
    const readmeBlob = yield readmeEntry.getBlob();
    readme = marky(readmeBlob.toString()).html();
  }

  const basePath = res.path !== '' ? res.path.split('/') : null;

  yield this.render('tree', {
    repoName: this.params.repo,
    ref: res.ref,
    readme, basePath, tree, files, directories
  });
})
.get('/:repo/blob/:path(.*)', function* getRepoBlob() {
  const repoPath = path.join(PATH, this.params.repo);
  const repo = yield Git.Repository.open(repoPath);

  const res = yield parseReferenceFromPath(repo, this.params.path);
  const commit = yield repo.getReferenceCommit(res.ref);
  const tree = yield commit.getTree();

  const blobEntry = yield tree.entryByPath(res.path);
  blobEntry.parent = tree;

  if (blobEntry.isBlob()) {
    const blob = yield blobEntry.getBlob();
    const content = blob.isBinary() ? "(Binary not shown)" : blob.toString();

    yield this.render('blob', {
      repoName: this.params.repo,
      ref: res.ref,
      basePath: res.path.split('/'),
      fcontent: content,
      fsize: blob.rawsize(),
      filename: path.basename(res.path)
    });
    return;
  }
})
.get('/:repo/raw/:path(.*)', function* getRepoRaw() {

})
.get('/:repo/commit/:hash', function* getRepoCommit() {

})
.get('/:repo/branches', function* getRepoBranches() {
  const repoPath = path.join(PATH, this.params.repo);
  const repo = yield Git.Repository.open(repoPath);

  const refs = yield repo.getReferences(Git.Reference.TYPE.LISTALL);
  const branches = getBranches(refs);

  yield this.render('branches', { repoName: this.params.repo, branches });
});

app.use(router.middleware());

app.listen(3001);
