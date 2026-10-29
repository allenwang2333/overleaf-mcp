import {it} from 'node:test';
import assert from 'node:assert/strict';
import {OverleafBrowser} from '../worker.mjs';

function fixture() {
  let url = 'about:blank';
  let navigations = 0;
  const page = {
    url: () => url,
    goto: async target => {
      navigations++;
      url = target;
      return {status: () => 200};
    },
  };
  const site = new OverleafBrowser(null, page, {
    base_url: 'https://www.overleaf.com', timeout_ms: 2000,
  });
  site.json = async () => ({projects: []});
  return {site, page, navigations: () => navigations};
}

it('does not reload an open dashboard or filtered dashboard', async () => {
  const {site, page, navigations} = fixture();
  await page.goto('https://www.overleaf.com/project/owned');
  assert.deepEqual(await site.status(), {authenticated: true});
  assert.equal(navigations(), 1);
});

it('recovers when a login redirect aborts dashboard navigation', async () => {
  const {site, page} = fixture();
  const goto = page.goto;
  let calls = 0;
  page.goto = async target => {
    if (++calls === 1) throw new Error('net::ERR_ABORTED at ' + target);
    return goto(target);
  };
  assert.deepEqual(await site.status(), {authenticated: true});
  assert.equal(calls, 2);
});

it('recovers when a redirect destroys the status request context', async () => {
  const {site} = fixture();
  let reads = 0;
  site.json = async () => {
    if (++reads === 1) throw new Error('Execution context was destroyed, most likely because of a navigation.');
    return {projects: []};
  };
  assert.deepEqual(await site.status(), {authenticated: true});
  assert.equal(reads, 2);
});

it('bounds navigation recovery and reports the reason', async () => {
  const {site, page} = fixture();
  let calls = 0;
  page.goto = async () => { calls++; throw new Error('net::ERR_ABORTED'); };
  const result = await site.status();
  assert.equal(result.authenticated, false);
  assert.match(result.message, /navigation/i);
  assert.equal(calls, 2);
});

it('does not retry other browser errors', async () => {
  const {site} = fixture();
  let reads = 0;
  site.json = async () => { reads++; throw new Error('net::ERR_CONNECTION_REFUSED'); };
  await assert.rejects(site.status(), /ERR_CONNECTION_REFUSED/);
  assert.equal(reads, 1);
});

it('does not retry a rejected session', async () => {
  const {site} = fixture();
  let reads = 0;
  site.json = async () => { reads++; throw Object.assign(new Error('HTTP 401'), {safe: true}); };
  assert.deepEqual(await site.status(), {authenticated: false, message: 'HTTP 401'});
  assert.equal(reads, 1);
});
