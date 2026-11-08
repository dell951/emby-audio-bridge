import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AudioCache} from '../src/cache.js';
const chunk=(start,duration=8)=>({start,buffer:{duration,length:duration*48000,numberOfChannels:2}});
test('recent backward seek reuses decoded audio',()=>{
 const c=new AudioCache(); c.add(chunk(100),100); c.add(chunk(108),108);c.prune(104);
 assert.equal(c.contains(105),true);assert.equal(c.frontier(104),116);
});
test('a gap cannot be mistaken for contiguous forward coverage',()=>{
 const c=new AudioCache();c.add(chunk(100),100);c.add(chunk(120),100);
 assert.equal(c.frontier(104),108);assert.equal(c.contains(115),false);
});
test('old audio expires and memory stays bounded',()=>{
 const c=new AudioCache({maxBytes:4*48000*2*8});
 c.add(chunk(0),0);c.add(chunk(8),8); assert.equal(c.chunks.length,1);
 c.prune(300);assert.equal(c.chunks.length,0);
});
