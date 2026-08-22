import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const runtime = await client.runtime.create({ template: 'base-small' });
const result = await runtime.runCode('print("Hello from GravixLayer")');
console.log(result.stdout);
await runtime.kill();
