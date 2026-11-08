import {test} from 'node:test';
import assert from 'node:assert/strict';
import {needsAudioBridge} from '../src/codecs.js';
test('DTS uses the same decoding and buffering path as Dolby audio',()=>{
 for(const codec of ['dts','ac3','eac3']) assert.equal(needsAudioBridge(codec),true);
});
test('native audio and unknown codec names remain untouched',()=>{
 for(const codec of ['aac','mp3','opus',undefined,'unknown']) assert.equal(needsAudioBridge(codec),false);
});
