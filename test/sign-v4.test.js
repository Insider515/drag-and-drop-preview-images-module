import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalRequest,
  encodePath,
  sha256,
  signRequest,
  stamp,
} from '../server/sign-v4.js';

/*
 * The figures below are AWS's own published test vectors for Signature
 * Version 4 — the same key, region, service and instant their documentation
 * uses — so these cases check the algorithm against its author rather than
 * against my reading of it.
 */
const KEY = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
  date: new Date('2015-08-30T12:36:00Z'),
};

describe('signing: against the published vectors', () => {
  test('get-vanilla: the canonical request is built as documented', () => {
    const { text, signedHeaders } = canonicalRequest({
      method: 'GET',
      path: '/',
      query: '',
      headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
      bodyHash: sha256(''),
    });

    assert.equal(text, [
      'GET',
      '/',
      '',
      'host:example.amazonaws.com',
      'x-amz-date:20150830T123600Z',
      '',
      'host;x-amz-date',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ].join('\n'));
    assert.equal(signedHeaders, 'host;x-amz-date');
  });

  test('get-vanilla: the string to sign and the signature match AWS', () => {
    const signed = signRequest({
      method: 'GET',
      path: '/',
      headers: { host: 'example.amazonaws.com' },
      bodyHash: sha256(''),
      ...KEY,
    });

    assert.equal(signed.stringToSign, [
      'AWS4-HMAC-SHA256',
      '20150830T123600Z',
      '20150830/us-east-1/service/aws4_request',
      'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
    ].join('\n'));
    assert.equal(
      signed.signature,
      '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
    );
  });

  test('get-vanilla: the Authorization header reads as it should', () => {
    const { headers } = signRequest({
      method: 'GET',
      path: '/',
      headers: { host: 'example.amazonaws.com' },
      bodyHash: sha256(''),
      ...KEY,
    });

    assert.equal(
      headers.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, '
      + 'SignedHeaders=host;x-amz-date, '
      + 'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
    );
  });

  test('a query string is part of what is signed', () => {
    // A query that is not signed is a query somebody else can add on the way.
    const base = {
      method: 'GET',
      path: '/',
      headers: { host: 'example.amazonaws.com' },
      bodyHash: sha256(''),
      ...KEY,
    };
    const withQuery = signRequest({ ...base, query: 'Param1=value1' });
    const without = signRequest(base);

    assert.notEqual(withQuery.signature, without.signature);
    assert.match(withQuery.canonical.split('\n')[2], /^Param1=value1$/);
  });
});

describe('signing: the pieces', () => {
  test('the timestamp is in both shapes the algorithm uses', () => {
    const { long, short } = stamp(new Date('2015-08-30T12:36:00Z'));
    assert.equal(long, '20150830T123600Z');
    assert.equal(short, '20150830');
  });

  test('a path is encoded segment by segment, keeping its slashes', () => {
    assert.equal(encodePath('/holiday photos/café.png'), '/holiday%20photos/caf%C3%A9.png');
    assert.equal(encodePath('/a/b/c'), '/a/b/c');
  });

  test("characters encodeURIComponent leaves alone are encoded anyway", () => {
    // S3 signs them encoded; leaving them raw is a signature that never matches.
    assert.equal(encodePath("/it's(here)!*"), '/it%27s%28here%29%21%2A');
  });

  test('header names are lower-cased and sorted, values collapsed', () => {
    const { text } = canonicalRequest({
      method: 'PUT',
      path: '/x',
      headers: { 'X-Custom': '  spaced   out  ', Host: 'e.example', 'Content-Type': 'image/png' },
      bodyHash: 'abc',
    });
    const lines = text.split('\n');
    assert.deepEqual(lines.slice(3, 6), [
      'content-type:image/png',
      'host:e.example',
      'x-custom:spaced out',
    ]);
  });

  test('a session token is signed along with the rest', () => {
    const withToken = signRequest({
      method: 'GET', path: '/', headers: { host: 'e.example' }, bodyHash: sha256(''),
      sessionToken: 'temporary', ...KEY,
    });
    assert.equal(withToken.headers['x-amz-security-token'], 'temporary');
    assert.match(withToken.headers.authorization, /x-amz-security-token/);
  });

  test('S3 gets the body hash in a header, and other services do not', () => {
    const s3 = signRequest({
      method: 'PUT', path: '/o', headers: { host: 'b.s3.amazonaws.com' },
      bodyHash: 'deadbeef', ...KEY, service: 's3',
    });
    assert.equal(s3.headers['x-amz-content-sha256'], 'deadbeef');

    const other = signRequest({
      method: 'GET', path: '/', headers: { host: 'e.example' }, bodyHash: sha256(''), ...KEY,
    });
    assert.equal(other.headers['x-amz-content-sha256'], undefined);
  });

  test('the signing key is derived per day, region and service', () => {
    // A key that leaks is useless for another day or another bucket's region.
    const base = { method: 'GET', path: '/', headers: { host: 'e.example' }, bodyHash: sha256('') };
    const monday = signRequest({ ...base, ...KEY });
    const tuesday = signRequest({ ...base, ...KEY, date: new Date('2015-08-31T12:36:00Z') });
    const elsewhere = signRequest({ ...base, ...KEY, region: 'eu-west-1' });

    assert.notEqual(monday.signature, tuesday.signature);
    assert.notEqual(monday.signature, elsewhere.signature);
  });
});
