import {test} from 'node:test';
import assert from 'node:assert/strict';
import {position,covers} from '../src/clock.js';
test('playback clock follows playback rate; pause freezes it',()=>{
  assert.equal(position({time:50,stamp:1000,rate:2,paused:false},1500),51);
  assert.equal(position({time:50,stamp:1000,rate:2,paused:true},1500),50);
});
test('audio boundaries use end exclusive intervals',()=>{
  const c={start:50,buffer:{duration:8}};
  assert.equal(covers(c,49),false); assert.equal(covers(c,50),true);
  assert.equal(covers(c,57.9),true); assert.equal(covers(c,58),false);
});
test('audio buffering freezes the video reference clock while playback is requested',()=>{
 assert.equal(position({time:300,stamp:1000,rate:1,paused:false,buffering:true},5000),300);
});
