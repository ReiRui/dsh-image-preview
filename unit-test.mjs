// Unit smoke test for dsh-image-preview (mock ctx, no running server).
import { apply, name, inject } from 'file:///D:/luoyu_projects/dsh-test/plugins/dsh-image-preview/lib/index.js';

console.log('exports: name=%s inject=%j', name, inject);

const root = 'D:/luoyu_projects/dsh-test/_preview_unit';
const routeRegistrations = [];
const toolRegistrations = [];
const fakeServer = {
  port: 3080,
  register: (r) => { routeRegistrations.push(r); return () => {}; },
};
const fakeTools = {
  register: (d) => { toolRegistrations.push(d); return () => {}; },
};
const ctx = { webServer: fakeServer, tools: fakeTools };
const disposer = apply(ctx, { root, prefix: '/preview' });

console.log('route registered:', routeRegistrations.length, '| tool registered:', toolRegistrations.length);
if (routeRegistrations.length !== 1 || toolRegistrations.length !== 1) process.exit(1);

const tool = toolRegistrations[0];
console.log('tool name:', tool.name, '| params:', JSON.stringify(tool.parameters));

// success: external file staged with unique name
const ok = await tool.execute({ file_path: 'C:/Users/lixun/.dsh/preview/theme-gallery.png' }, {});
console.log('success:', JSON.stringify(ok));
if (!ok.ok || !ok.url.startsWith('http://127.0.0.1:3080/preview/')) process.exit(1);

// already-inside path: no re-copy, uses basename
const ok2 = await tool.execute({ file_path: ok.url.replace('http://127.0.0.1:3080/preview/', root + '/') }, {});
console.log('already-inside:', JSON.stringify(ok2));

// missing file
const miss = await tool.execute({ file_path: 'D:/definitely/not/here.png' }, {});
console.log('missing:', JSON.stringify(miss));
if (miss.ok) process.exit(1);

// unsupported extension
const bad = await tool.execute({ file_path: 'D:/luoyu_projects/dsh-test/web-restart.ps1' }, {});
console.log('bad-ext:', JSON.stringify(bad));
if (bad.ok) process.exit(1);

// route handler smoke: serve the staged file through the captured handler
const route = routeRegistrations[0];
console.log('route kind/path:', route.kind, route.path);
const stagedName = ok.path;
let status = 0, type = '', bodyLen = 0;
const fakeRes = {
  writeHead: (s, h) => { status = s; if (h) type = h['Content-Type']; },
  end: (d) => { bodyLen = d ? d.length : 0; },
};
await route.handler({ url: '/preview/' + stagedName }, fakeRes);
console.log('handler on staged file: status=%d type=%s bytes=%d', status, type, bodyLen);
if (status !== 200 || type !== 'image/png' || bodyLen < 100) process.exit(1);

// handler rejects traversal
status = 0;
await route.handler({ url: '/preview/..%2f..%2fsettings.yaml' }, fakeRes);
console.log('handler on traversal: status=%d', status);
if (status !== 400 && status !== 403 && status !== 404) process.exit(1);

// disposer runs without throwing
disposer();
console.log('disposer OK');

console.log('ALL UNIT CHECKS PASSED');
