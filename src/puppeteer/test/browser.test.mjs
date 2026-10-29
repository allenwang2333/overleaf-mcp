import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';
import {OverleafBrowser} from '../worker.mjs';

const PROJECT = 'a'.repeat(24);
const MAIN = 'b'.repeat(24);
const FOLDER = 'c'.repeat(24);
const INTRO = 'd'.repeat(24);
const NEW = 'e'.repeat(24);
const sha = text => createHash('sha256').update(text).digest('hex');
let server, browser, site, origin, bundle, page;
let docs, requests, compileStatus, externalOutput, authorized, writable, saveEnabled;

function html() {
  return `<!doctype html><html><head><meta name="ol-csrfToken" content="fixture-token"></head>
<body><ul class="file-tree-folder-list"><div class="file-tree-folder-list-inner" id="root">
<li aria-label="chapters" aria-expanded="false"><div data-file-id="${FOLDER}" data-file-type="folder">
<button class="file-tree-entity-button">chapters</button></div></li>
</div></ul><div id="editor"></div><script type="module" src="/editor.js"></script></body></html>`;
}

async function handle(req, res) {
  requests.push({url: req.url, method: req.method, csrf: req.headers['x-csrf-token']});
  let body = '';
  for await (const chunk of req) body += chunk;
  const path = new URL(req.url, origin).pathname;
  const send = value => {res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));};
  if (path === '/editor.js') {res.setHeader('Content-Type', 'text/javascript'); res.end(bundle); return;}
  if (path === '/project' || path === `/project/${PROJECT}` || path === '/login') {
    res.setHeader('Content-Type', 'text/html'); res.end(html()); return;
  }
  if (!authorized) {res.writeHead(401); res.end(); return;}
  if (path === '/user/projects') return send({projects: [{_id: PROJECT, name: 'Fixture', accessLevel: 'owner'}]});
  if (path === '/test/docs') return send({docs, writable, saveEnabled});
  if (path === '/test/save') {
    const {id, content} = JSON.parse(body);
    if (saveEnabled) docs.find(doc => doc.id === id).content = content;
    return send({ok: true});
  }
  if (path === `/project/${PROJECT}/entities`) {
    return send({entities: docs.map(doc => ({path: '/' + doc.path, type: 'doc'}))});
  }
  if (path.endsWith('/download')) {
    const doc = docs.find(doc => path.includes(doc.id));
    if (doc) {res.end(doc.content); return;}
  }
  if (path === '/project/new') return send({project_id: PROJECT});
  if (path === `/project/${PROJECT}/doc`) {
    const data = JSON.parse(body);
    docs.push({id: NEW, path: (data.parent_folder_id ? 'chapters/' : '') + data.name, content: ''});
    return send({_id: NEW});
  }
  if (path === `/project/${PROJECT}/compile`) {
    return send({status: compileStatus, outputFiles: [
      {path: 'output.pdf', url: externalOutput ? 'https://evil.example/output.pdf'
        : `/project/${PROJECT}/build/fixture-build/output/output.pdf`},
      {path: 'output.log', url: `/project/${PROJECT}/build/fixture-build/output/output.log`},
    ]});
  }
  if (path.endsWith('/output.pdf')) {res.end('%PDF-1.7\nfixture'); return;}
  if (path.endsWith('/output.log')) {res.end(compileStatus === 'success' ? 'Build succeeded' : '! Undefined control sequence'); return;}
  res.writeHead(404); res.end();
}

before(async () => {
  const built = await build({bundle: true, write: false, format: 'esm', stdin: {
    resolveDir: process.cwd(), contents: `
import {EditorState} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
let view, currentId;
const elements = new Map();
const folder = document.querySelector('li[aria-label="chapters"]');
folder.querySelector('button').onclick = () => {
  folder.setAttribute('aria-expanded', 'true');
  const ul = document.createElement('ul'); ul.className = 'file-tree-folder-list';
  ul.innerHTML = '<div class="file-tree-folder-list-inner" id="nested"></div>';
  folder.after(ul);
  for (const [id, el] of elements) if (el.dataset.nested) ul.firstElementChild.append(el);
};
async function refresh() {
  const data = await (await fetch('/test/docs')).json();
  for (const doc of data.docs) {
    if (elements.has(doc.id)) continue;
    const li = document.createElement('li');
    li.setAttribute('aria-label', doc.path.split('/').pop());
    li.setAttribute('aria-selected', 'false');
    li.innerHTML = '<div data-file-id="' + doc.id + '" data-file-type="doc"><div class="entity-name"></div></div>';
    li.querySelector('.entity-name').textContent = doc.path.split('/').pop();
    if (doc.path.includes('/')) li.dataset.nested = 'true';
    elements.set(doc.id, li);
    const target = li.dataset.nested ? document.querySelector('#nested') : document.querySelector('#root');
    target?.append(li);
    li.onclick = async () => {
      for (const el of elements.values()) el.setAttribute('aria-selected', 'false');
      li.setAttribute('aria-selected', 'true');
      const latest = await (await fetch('/test/docs')).json();
      const content = latest.docs.find(d => d.id === doc.id).content;
      view?.destroy(); currentId = doc.id;
      view = new EditorView({parent: document.querySelector('#editor'), state: EditorState.create({
        doc: content, extensions: [EditorView.editable.of(latest.writable), EditorView.updateListener.of(update => {
          if (update.docChanged) fetch('/test/save', {method: 'POST', body: JSON.stringify({
            id: currentId, content: update.state.doc.toString()
          })});
        })]
      })});
      window.dispatchEvent(new CustomEvent('doc:after-opened'));
    };
  }
}
await refresh();
setInterval(() => refresh().catch(() => {}), 50);
`,
  }});
  bundle = built.outputFiles[0].text;
  server = createServer((req, res) => {void handle(req, res).catch(error => {
    res.writeHead(500); res.end(String(error));
  });});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({channel: 'chrome', headless: true});
  page = await browser.newPage();
  page.setDefaultTimeout(3000);
  site = new OverleafBrowser(browser, page, {base_url: origin, timeout_ms: 2000});
});

after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve));
});

beforeEach(async () => {
  docs = [{id: MAIN, path: 'main.tex', content: 'hello π\n'}, {id: INTRO, path: 'chapters/intro.tex', content: 'intro'}];
  requests = [];
  compileStatus = 'success'; externalOutput = false; authorized = true; writable = true; saveEnabled = true;
  site.builds.clear();
  await page.goto('about:blank');
});

describe('Puppeteer against a local Overleaf fixture with real CodeMirror 6', () => {
  it('checks login and reads projects using the browser session', async () => {
    assert.deepEqual(await site.status(), {authenticated: true});
    assert.equal((await site.listProjects()).projects[0].project_id, PROJECT);
  });
  it('reports missing login', async () => {
    authorized = false;
    assert.equal((await site.status()).authenticated, false);
  });
  it('lists and reads full Unicode source, including nested files', async () => {
    assert.equal((await site.listFiles(PROJECT)).files[1].path, 'chapters/intro.tex');
    assert.equal((await site.readFile(PROJECT, 'main.tex')).content, 'hello π\n');
    assert.equal((await site.readFile(PROJECT, 'chapters/intro.tex')).content, 'intro');
  });
  it('writes through CodeMirror and confirms the server snapshot', async () => {
    const result = await site.writeFile(PROJECT, 'main.tex', '\\section{你好}\n', sha('hello π\n'));
    assert.equal(result.saved, true);
    assert.equal(docs[0].content, '\\section{你好}\n');
    assert.equal((await site.readFile(PROJECT, 'main.tex')).content, docs[0].content);
  });
  it('rejects stale hashes without changes', async () => {
    await assert.rejects(site.writeFile(PROJECT, 'main.tex', 'bad', sha('stale')), /changed since/);
    assert.equal(docs[0].content, 'hello π\n');
  });
  it('rejects local unsaved changes even if the server hash matches', async () => {
    await site.readFile(PROJECT, 'main.tex'); await site.openDoc(MAIN);
    saveEnabled = false;
    await page.evaluate(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view;
      view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: 'local change'}});
    });
    await assert.rejects(site.writeFile(PROJECT, 'main.tex', 'bad', sha('hello π\n')), /conflict/);
  });
  it('rejects a read-only editor', async () => {
    writable = false;
    await assert.rejects(site.writeFile(PROJECT, 'main.tex', 'bad', sha('hello π\n')), /readonly/);
  });
  it('does not claim a save when server confirmation fails', async () => {
    saveEnabled = false;
    await assert.rejects(site.writeFile(PROJECT, 'main.tex', 'new', sha('hello π\n')), /saving was not confirmed/);
  });
  it('creates projects and sends the CSRF token', async () => {
    assert.equal((await site.createProject('New project')).project_id, PROJECT);
    assert.equal(requests.find(r => r.url === '/project/new').csrf, 'fixture-token');
  });
  it('creates a populated file in an existing folder', async () => {
    const result = await site.createFile(PROJECT, 'chapters/new.tex', 'new text');
    assert.equal(result.saved, true);
    assert.equal(docs.find(d => d.id === NEW).content, 'new text');
  });
  it('does not replace existing files during creation', async () => {
    await assert.rejects(site.createFile(PROJECT, 'main.tex', 'bad'), /already exists/);
    assert.equal(docs.length, 2);
  });
  it('compiles, reads logs, downloads the PDF, and invalidates builds on edits', async () => {
    const result = await site.compile(PROJECT);
    assert.equal(result.status, 'success'); assert.equal(result.log, 'Build succeeded');
    const pdf = await site.downloadPdf(PROJECT);
    assert.ok(Buffer.from(pdf.base64, 'base64').toString().startsWith('%PDF-'));
    await site.writeFile(PROJECT, 'main.tex', 'changed', sha('hello π\n'));
    await assert.rejects(site.downloadPdf(PROJECT), /Run compile_project first/);
  });
  it('returns compile failures without offering an old PDF', async () => {
    await site.compile(PROJECT); compileStatus = 'error';
    const result = await site.compile(PROJECT);
    assert.equal(result.has_pdf, false); assert.match(result.log, /Undefined/);
    await assert.rejects(site.downloadPdf(PROJECT), /Run compile_project first/);
  });
  it('never follows external compile output URLs', async () => {
    externalOutput = true;
    await assert.rejects(site.compile(PROJECT), /No external URL was fetched/);
  });
});
