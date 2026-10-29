import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';

const SOURCE_LIMIT = 1024 * 1024;
const hash = text => createHash('sha256').update(text).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw Object.assign(new Error(message), {safe: true}); };

export class OverleafBrowser {
  constructor(browser, page, settings) {
    this.browser = browser;
    this.page = page;
    this.settings = settings;
    this.origin = new URL(settings.base_url).origin;
    this.builds = new Map();
  }

  async goto(path) {
    const response = await this.page.goto(this.origin + path, {waitUntil: 'domcontentloaded'});
    if (response && response.status() >= 400) {
      fail(`Overleaf page returned HTTP ${response.status()}. Check access or verification.`);
    }
  }

  async dashboard() {
    const url = new URL(this.page.url());
    if (url.origin !== this.origin || !/^\/project(?:\/|$)/.test(url.pathname)) {
      await this.goto('/project');
    }
    const current = new URL(this.page.url());
    if (current.origin !== this.origin || !/^\/project(?:\/|$)/.test(current.pathname)) {
      fail("Login required. Stop the server and run 'overleaf-mcp login'.");
    }
  }

  async project(id) {
    await this.dashboard();
    if (new URL(this.page.url()).pathname !== `/project/${id}`) {
      await this.goto(`/project/${id}`);
    }
    if (new URL(this.page.url()).pathname !== `/project/${id}`) {
      fail('Project is unavailable. Check login and project permissions.');
    }
    await this.page.waitForSelector('[data-file-id]', {visible: true});
  }

  async request(path, {method = 'GET', body, binary = false, maxBytes = SOURCE_LIMIT} = {}) {
    if (new URL(this.page.url()).origin !== this.origin) fail('Browser is outside Overleaf.');
    const result = await this.page.evaluate(async args => {
      const tokenElement = document.querySelector('meta[name="ol-csrfToken"]');
      let token = tokenElement?.content;
      if (tokenElement?.dataset.type === 'json') token = JSON.parse(token);
      const response = await fetch(args.path, {
        method: args.method,
        credentials: 'same-origin',
        redirect: 'error',
        signal: AbortSignal.timeout(args.timeout),
        headers: {
          Accept: args.binary ? 'application/pdf' : '*/*',
          ...(args.body !== undefined ? {'Content-Type': 'application/json'} : {}),
          ...(token ? {'X-Csrf-Token': token} : {}),
        },
        ...(args.body !== undefined ? {body: JSON.stringify(args.body)} : {}),
      });
      if (!response.ok) return {status: response.status};
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > args.maxBytes) {
          await reader.cancel();
          return {tooLarge: true};
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (!args.binary) return {text: new TextDecoder('utf-8', {fatal: true}).decode(bytes)};
      let text = '';
      for (let i = 0; i < size; i += 8192) {
        text += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      return {base64: btoa(text)};
    }, {path, method, body, binary, maxBytes, timeout: this.settings.timeout_ms});
    if (result.status) fail(`Overleaf returned HTTP ${result.status}. Check login, access, or limits.`);
    if (result.tooLarge) fail(`Overleaf response exceeds the ${maxBytes}-byte limit.`);
    return binary ? result.base64 : result.text;
  }

  async json(path, options) {
    const text = await this.request(path, {...options, maxBytes: 4 * SOURCE_LIMIT});
    try { return JSON.parse(text); }
    catch { fail('Overleaf did not return JSON. Check login or browser verification.'); }
  }

  async status() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.dashboard();
        const result = await this.json('/user/projects');
        return {authenticated: Array.isArray(result.projects)};
      } catch (error) {
        // Login redirects can interrupt navigation or replace the JS context.
        // Only this read-only check is retried; mutations are never replayed.
        const navigating = /net::ERR_ABORTED|Execution context was destroyed|Cannot find context with specified id/
          .test(error.message);
        if (navigating && attempt === 0) {
          await pause(250);
          continue;
        }
        if (navigating) {
          return {authenticated: false, message:
            'Login check was interrupted by page navigation. Wait for the dashboard to finish loading.'};
        }
        if (error.safe) return {authenticated: false, message: error.message};
        throw error;
      }
    }
  }

  async listProjects() {
    await this.dashboard();
    const result = await this.json('/user/projects');
    if (!Array.isArray(result.projects)) fail('Overleaf project list format has changed.');
    return {projects: result.projects.map(p => ({
      project_id: p._id, name: p.name, access_level: p.accessLevel,
    }))};
  }

  async listFiles(id) {
    await this.dashboard();
    const result = await this.json(`/project/${id}/entities`);
    if (!Array.isArray(result.entities)) fail('Overleaf file list format has changed.');
    return {project_id: id, files: result.entities.map(e => ({
      path: e.path.replace(/^\//, ''), type: e.type,
    }))};
  }

  // Overleaf renders each expanded folder's UL immediately after its LI.
  async resolve(path, type = 'doc') {
    const parts = path.split('/');
    let parentId = null;
    for (let index = 0; index < parts.length; index++) {
      const entity = await this.page.evaluate(({parentId, name}) => {
        let tree;
        if (parentId) {
          const folder = document.querySelector(`[data-file-id="${parentId}"]`);
          tree = folder?.closest('li')?.nextElementSibling;
        } else {
          tree = [...document.querySelectorAll('ul.file-tree-folder-list')].find(
            node => !node.parentElement.closest('ul.file-tree-folder-list'),
          );
        }
        const inner = tree?.querySelector(':scope > .file-tree-folder-list-inner');
        for (const item of inner?.children ?? []) {
          if (item.tagName !== 'LI' || item.getAttribute('aria-label') !== name) continue;
          const data = item.querySelector('[data-file-id]');
          if (data) return {id: data.dataset.fileId, type: data.dataset.fileType};
        }
        return null;
      }, {parentId, name: parts[index]});
      if (!entity || !/^[a-f0-9]{24}$/.test(entity.id)) fail(`Project path not found: ${path}`);
      const last = index === parts.length - 1;
      if (last) {
        if (entity.type !== type) fail(`Expected a ${type} at ${path}, found ${entity.type}.`);
        return entity.id;
      }
      if (entity.type !== 'folder') fail(`Parent path is not a folder: ${path}`);
      const selector = `[data-file-id="${entity.id}"]`;
      const expanded = await this.page.$eval(selector, el =>
        el.closest('li').getAttribute('aria-expanded') === 'true');
      if (!expanded) await this.page.click(`${selector} .file-tree-entity-button`);
      await this.page.waitForFunction(id => {
        const folder = document.querySelector(`[data-file-id="${id}"]`);
        return folder?.closest('li')?.nextElementSibling?.matches('ul.file-tree-folder-list');
      }, {}, entity.id);
      parentId = entity.id;
    }
  }

  async saved(id, docId) {
    return this.request(`/project/${id}/doc/${docId}/download`);
  }

  async readFile(id, path) {
    await this.project(id);
    const docId = await this.resolve(path);
    return {project_id: id, path, content: await this.saved(id, docId)};
  }

  async openDoc(docId) {
    const selected = await this.page.$eval(`[data-file-id="${docId}"]`, el =>
      el.closest('li').getAttribute('aria-selected') === 'true');
    if (!selected) {
      await this.page.evaluate(() => {
        window.__overleafMcpOpened = false;
        window.addEventListener('doc:after-opened', () => {
          window.__overleafMcpOpened = true;
        }, {once: true});
      });
      await this.page.click(`[data-file-id="${docId}"] .entity-name`);
      await this.page.waitForFunction(() => window.__overleafMcpOpened === true);
    }
    await this.page.waitForFunction(() => {
      const content = [...document.querySelectorAll('.cm-content')].find(el => el.checkVisibility());
      return !!(content?.cmView?.view ?? content?.cmTile?.root?.view);
    });
  }

  async writeFile(id, path, content, expectedHash) {
    await this.project(id);
    const docId = await this.resolve(path);
    const old = await this.saved(id, docId);
    if (hash(old) !== expectedHash) fail('File changed since read_file. Read it again before editing.');
    await this.openDoc(docId);
    const outcome = await this.page.evaluate(({old, content}) => {
      const element = [...document.querySelectorAll('.cm-content')].find(el => el.checkVisibility());
      const view = element?.cmView?.view ?? element?.cmTile?.root?.view;
      if (!view) return 'missing';
      if (view.contentDOM !== element || element.getAttribute('contenteditable') !== 'true') {
        return 'readonly';
      }
      if (view.state.doc.toString() !== old) return 'conflict';
      if (old !== content) {
        view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: content}});
      }
      return view.state.doc.toString() === content ? 'ok' : 'rejected';
    }, {old, content});
    if (outcome !== 'ok') {
      fail(`Editor refused the change (${outcome}). Use Code Editor mode and read the file again.`);
    }
    const deadline = Date.now() + this.settings.timeout_ms;
    while (Date.now() < deadline) {
      if (await this.saved(id, docId) === content) {
        this.builds.delete(id);
        return {project_id: id, path, sha256: hash(content), saved: true};
      }
      await pause(250);
    }
    fail('Change was sent but saving was not confirmed. Read the file before retrying.');
  }

  async createProject(name) {
    await this.dashboard();
    const result = await this.json('/project/new', {
      method: 'POST', body: {projectName: name, template: 'none'},
    });
    if (!/^[a-f0-9]{24}$/.test(result.project_id)) {
      fail('Project creation response is unknown. List projects before retrying.');
    }
    return {project_id: result.project_id, name};
  }

  async createFile(id, path, content) {
    const {files} = await this.listFiles(id);
    if (files.some(file => file.path === path)) fail('Path already exists. No file was created.');
    await this.project(id);
    const parts = path.split('/');
    const name = parts.pop();
    const parent = parts.length ? await this.resolve(parts.join('/'), 'folder') : null;
    if (parent) {
      const selector = `[data-file-id="${parent}"]`;
      const expanded = await this.page.$eval(selector, el =>
        el.closest('li').getAttribute('aria-expanded') === 'true');
      if (!expanded) await this.page.click(`${selector} .file-tree-entity-button`);
      await this.page.waitForFunction(parent => {
        const folder = document.querySelector(`[data-file-id="${parent}"]`);
        return folder?.closest('li')?.nextElementSibling?.matches('ul.file-tree-folder-list');
      }, {}, parent);
    }
    const result = await this.json(`/project/${id}/doc`, {
      method: 'POST', body: {name, parent_folder_id: parent},
    });
    if (!/^[a-f0-9]{24}$/.test(result._id)) {
      fail('File creation response is unknown. List files before retrying.');
    }
    this.builds.delete(id);
    if (!content) return {project_id: id, path, sha256: hash(''), saved: true};
    try {
      await this.page.waitForSelector(`[data-file-id="${result._id}"]`);
      return await this.writeFile(id, path, content, hash(''));
    } catch {
      fail('File was created, but content saving failed. Read the file before retrying.');
    }
  }

  outputUrl(id, file, data) {
    const url = new URL(file.url, this.origin);
    const pattern = new RegExp(`^/project/${id}/(?:user/[a-f0-9]{24}/)?` +
      '(?:build/[a-zA-Z0-9-]+/)?output/output\\.(?:pdf|log)$');
    if (url.origin !== this.origin || !pattern.test(url.pathname) || url.username || url.password) {
      fail('Unsupported compile output URL. No external URL was fetched.');
    }
    if (data.clsiServerId) url.searchParams.set('clsiserverid', data.clsiServerId);
    return url.pathname + url.search;
  }

  async compile(id) {
    await this.dashboard();
    this.builds.delete(id);
    const data = await this.json(`/project/${id}/compile?file_line_errors=true`, {
      method: 'POST', body: {check: 'silent', incrementalCompilesEnabled: true, stopOnFirstError: false},
    });
    if (typeof data.status !== 'string') fail('Overleaf compile response format has changed.');
    const files = data.outputFiles ?? [];
    const pdf = files.find(file => file.path === 'output.pdf');
    if (data.status === 'success' && pdf) this.builds.set(id, this.outputUrl(id, pdf, data));
    let log = '';
    let logError;
    const logFile = files.find(file => file.path === 'output.log');
    if (logFile) {
      try { log = await this.request(this.outputUrl(id, logFile, data)); }
      catch { logError = 'Compile finished, but the log could not be read (limit: 1 MiB).'; }
    }
    return {
      project_id: id, status: data.status, has_pdf: this.builds.has(id),
      log: log.slice(0, 65536), log_truncated: log.length > 65536,
      ...(logError ? {log_error: logError} : {}),
    };
  }

  async downloadPdf(id) {
    await this.dashboard();
    const url = this.builds.get(id);
    if (!url) fail('No successful build in this session. Run compile_project first.');
    return {base64: await this.request(url, {binary: true, maxBytes: 25 * SOURCE_LIMIT})};
  }

  async command(method, params) {
    const id = params.project_id;
    switch (method) {
      case 'login': await this.goto('/login'); return null;
      case 'status': return this.status();
      case 'list_projects': return this.listProjects();
      case 'list_files': return this.listFiles(id);
      case 'read_file': return this.readFile(id, params.path);
      case 'write_file': return this.writeFile(id, params.path, params.content, params.expected_sha256);
      case 'create_project': return this.createProject(params.name);
      case 'create_file': return this.createFile(id, params.path, params.content);
      case 'compile': return this.compile(id);
      case 'download_pdf': return this.downloadPdf(id);
      default: fail('Unknown browser command.');
    }
  }
}

export async function runWorker() {
  let browser;
  let launching;
  let site;
  let closing;
  const close = () => closing ??= (async () => {
    await launching?.catch(() => {});
    await browser?.close();
  })();
  const onEnd = () => { void close(); };
  const onSignal = () => { void close().finally(() => process.exit(0)); };
  process.stdin.once('end', onEnd);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onSignal);
  const lines = createInterface({input: process.stdin, crlfDelay: Infinity});
  try {
    for await (const line of lines) {
      if (closing) break;
      try {
        const {method, params = {}} = JSON.parse(line);
        let result;
        if (method === 'launch') {
          const {default: puppeteer} = await import('puppeteer-core');
          launching = puppeteer.launch({
            ...(params.chrome_path ? {executablePath: params.chrome_path} : {channel: 'chrome'}),
            userDataDir: params.profile_dir, headless: params.headless,
            defaultViewport: {width: 1440, height: 1000}, timeout: params.timeout_ms,
            handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
          }).then(instance => { browser = instance; return instance; });
          await launching;
          const page = (await browser.pages())[0] ?? await browser.newPage();
          page.setDefaultTimeout(params.timeout_ms);
          page.setDefaultNavigationTimeout(params.timeout_ms);
          site = new OverleafBrowser(browser, page, params);
          result = null;
        } else {
          if (!site) fail('Browser is not running.');
          result = await site.command(method, params);
        }
        process.stdout.write(JSON.stringify({ok: true, result}) + '\n');
      } catch (error) {
        const message = error.safe ? error.message
          : error.code === 'ERR_MODULE_NOT_FOUND' ? 'Run npm ci in src/puppeteer first.'
          : error.name === 'TimeoutError' || error.name === 'TimeoutErrorImpl'
            ? 'Browser operation timed out. Inspect the project before retrying changes.'
            : 'Browser operation failed. Check Chrome, profile lock, login, and Code Editor mode. ' +
              'Inspect the project before retrying changes.';
        process.stdout.write(JSON.stringify({ok: false, error: message}) + '\n');
      }
    }
  } finally {
    await close();
    lines.close();
    process.stdin.off('end', onEnd);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, onSignal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runWorker();
