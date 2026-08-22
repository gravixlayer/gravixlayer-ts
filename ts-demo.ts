import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const sandbox = await client.runtime.create({ template: 'base-small' });
const result = await sandbox.runCode('print("Hello from GravixLayer")');
console.log(result.stdout);
await sandbox.kill();
