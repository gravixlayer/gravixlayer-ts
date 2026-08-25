import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer(); // defaults to cloud="aws", region="us-east-1"
const sandbox = await client.runtime.create(); // defaults to template="base-small"

console.log((await sandbox.runCode("print('hello')")).text);
console.log((await sandbox.runCmd('python', { args: ['--version'] })).stdout);

await sandbox.file.write('/workspace/hello.txt', 'hi\n');
console.log((await sandbox.file.read('/workspace/hello.txt')).content);

await sandbox.kill();
