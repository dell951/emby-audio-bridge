import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AudioTimeline} from '../src/timeline.js';
function fixture() {
  const nodes=[];
  const ctx={currentTime:10,createBufferSource(){
    const n={playbackRate:{},connect(){},disconnect(){},start(...args){this.args=args;},stop(){this.stopped=true;}};
    nodes.push(n); return n;
  }};
  return {ctx,nodes,timeline:new AudioTimeline(ctx,{})};
}
test('adjacent audio chunks are scheduled without waiting for a timer',()=>{
  const {timeline,nodes}=fixture();
  timeline.sync(100,1,[{start:100,buffer:{duration:8}},{start:108,buffer:{duration:8}}]);
  assert.deepEqual(nodes.map(n=>n.args),[[10,0],[18,0]]);
});
test('pause cancels both current and future audio nodes',()=>{
  const {timeline,nodes}=fixture();
  timeline.sync(100,1,[{start:100,buffer:{duration:8}},{start:108,buffer:{duration:8}}]);
  timeline.stop();
  assert.ok(nodes.every(n=>n.stopped)); assert.equal(timeline.active,false);
});
test('seek discards scheduled audio and starts at new video offset',()=>{
  const {timeline,nodes,ctx}=fixture();
  const c={start:100,buffer:{duration:8}};
  timeline.sync(100,1,[c]); ctx.currentTime=11;
  timeline.sync(105,1,[c]);
  assert.equal(nodes[0].stopped,true); assert.deepEqual(nodes[1].args,[11,5]);
});
test('playback rate changes preserve boundary scheduling',()=>{
  const {timeline,nodes}=fixture();
  timeline.sync(100,2,[{start:100,buffer:{duration:8}},{start:108,buffer:{duration:8}}]);
  assert.deepEqual(nodes.map(n=>n.args),[[10,0],[14,0]]);
});
