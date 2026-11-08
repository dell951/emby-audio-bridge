import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mustWait,resumeSeconds} from '../src/buffer-policy.js';
test('resume waits for six seconds rather than repeatedly restarting on tiny chunks',()=>{
 assert.equal(mustWait({available:2,buffering:true,rate:1,remaining:100}),true);
 assert.equal(mustWait({available:6,buffering:true,rate:1,remaining:100}),false);
});
test('running playback stops before audio runs out',()=>{
 assert.equal(mustWait({available:.1,buffering:false,rate:1,remaining:100}),true);
 assert.equal(mustWait({available:3,buffering:false,rate:1,remaining:100}),false);
});
test('faster playback gets the same wall-clock reserve and endings need no impossible reserve',()=>{
 assert.equal(resumeSeconds(2,100),12);assert.equal(resumeSeconds(1,1),1);
});
