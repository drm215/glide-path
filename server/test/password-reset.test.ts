import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createResendMailer } from '../src/mailer.ts';
import { startTestServer } from './helpers.ts';

type Server = Awaited<ReturnType<typeof startTestServer>>;

describe('password reset', () => {
  let server: Server;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.stop();
  });

  const forgot = (email: string) => server.request('POST', '/api/auth/forgot', { body: { email } });
  const reset = (email: string, code: string, password = 'brand new password') => server.request('POST', '/api/auth/reset', { body: { email, code, password } });
  const login = (email: string, password: string) => server.request('POST', '/api/auth/login', { body: { email, password } });
  const lastCode = (email: string) => server.sentCodes.findLast((item) => item.to === email)!.code;

  test('emails a code, which resets the password and signs in', async () => {
    await server.register('forgetful@example.com', 'Forgetful');
    const sent = await forgot('Forgetful@Example.com');
    assert.equal(sent.status, 200);
    const code = lastCode('forgetful@example.com');
    assert.match(code, /^\d{6}$/);

    const done = await reset('forgetful@example.com', code);
    assert.equal(done.status, 200);
    assert.ok(done.body.token, 'signed in after resetting');
    assert.equal(done.body.user.displayName, 'Forgetful');
    assert.equal((await login('forgetful@example.com', 'brand new password')).status, 200);
    assert.equal((await login('forgetful@example.com', 'correct horse')).status, 401, 'old password no longer works');
    assert.equal((await reset('forgetful@example.com', code)).status, 400, 'a code works only once');
  });

  test('resetting signs out every other session', async () => {
    const oldToken = await server.register('stolen@example.com');
    const me = (token: string) => server.request('GET', '/api/me', { token });
    assert.equal((await me(oldToken)).status, 200);
    await forgot('stolen@example.com');
    const done = await reset('stolen@example.com', lastCode('stolen@example.com'));
    assert.equal((await me(oldToken)).status, 401, 'the old token is refused');
    assert.equal((await me(done.body.token)).status, 200, 'the new token works');
    const relogin = await login('stolen@example.com', 'brand new password');
    assert.equal((await me(relogin.body.token)).status, 200);
  });

  test('answers the same for unknown emails and sends nothing', async () => {
    const before = server.sentCodes.length;
    const response = await forgot('nobody@example.com');
    assert.equal(response.status, 200);
    assert.equal(response.body.message, 'If that email has an account, a reset code is on its way.');
    assert.equal(server.sentCodes.length, before);
    assert.equal((await reset('nobody@example.com', '123456')).status, 400);
  });

  test('wrong codes count against the code, which locks after 5 tries', async () => {
    await server.register('guesser@example.com');
    await forgot('guesser@example.com');
    const code = lastCode('guesser@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await reset('guesser@example.com', wrong)).status, 400);
    assert.equal((await reset('guesser@example.com', code)).status, 400, 'even the right code fails once locked');
  });

  test('only the newest code works, and codes expire', async () => {
    await server.register('twice@example.com');
    await forgot('twice@example.com');
    const first = lastCode('twice@example.com');
    await forgot('twice@example.com');
    const second = lastCode('twice@example.com');
    if (first !== second) assert.equal((await reset('twice@example.com', first)).status, 400, 'older code replaced');

    await server.db.query("UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE NOT used");
    assert.equal((await reset('twice@example.com', second)).status, 400, 'expired');
  });

  test('limits how many codes one account can be sent', async () => {
    await server.register('flooded@example.com');
    const before = server.sentCodes.filter((item) => item.to === 'flooded@example.com').length;
    for (let request = 0; request < 5; request += 1) assert.equal((await forgot('flooded@example.com')).status, 200);
    assert.equal(server.sentCodes.filter((item) => item.to === 'flooded@example.com').length - before, 3);
  });

  test('long-expired codes are cleared out when a new one is sent', async () => {
    await server.register('tidy@example.com');
    await forgot('tidy@example.com');
    await server.db.query("UPDATE password_resets SET expires_at = now() - interval '2 days', created_at = now() - interval '2 days'");
    await forgot('tidy@example.com');
    const { rows } = await server.db.query<{ count: number }>("SELECT count(*)::int AS count FROM password_resets WHERE expires_at < now() - interval '1 day'");
    assert.equal(rows[0].count, 0);
  });

  test('rejects malformed codes and short passwords', async () => {
    assert.equal((await reset('forgetful@example.com', '12ab56')).status, 400);
    assert.equal((await reset('forgetful@example.com', '123456', 'short')).status, 400);
  });

  test('reports when email is not set up', async () => {
    const unconfigured = await startTestServer({ mailer: null });
    try {
      const response = await unconfigured.request('POST', '/api/auth/forgot', { body: { email: 'x@example.com' } });
      assert.equal(response.status, 503);
      assert.match(response.body.error, /isn’t set up/);
    } finally {
      await unconfigured.stop();
    }
  });

  test('a failed send is reported, not hidden', async () => {
    const failing = await startTestServer({ mailer: { sendPasswordResetCode: async () => { throw new Error('provider down'); } } });
    try {
      await failing.register('unlucky@example.com');
      const response = await failing.request('POST', '/api/auth/forgot', { body: { email: 'unlucky@example.com' } });
      assert.equal(response.status, 502);
    } finally {
      await failing.stop();
    }
  });
});

describe('Resend mailer', () => {
  test('sends the code with the API key, from address and recipient', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"id":"x"}', { status: 200 });
    }) as unknown as typeof fetch;
    await createResendMailer('re_test', 'Glide Path <no-reply@glidepathdiscgolf.com>', fakeFetch).sendPasswordResetCode('pat@example.com', '042517');
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer re_test');
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.to, 'pat@example.com');
    assert.equal(body.from, 'Glide Path <no-reply@glidepathdiscgolf.com>');
    assert.match(body.subject, /042517/);
    assert.match(body.text, /042517/);
  });

  test('throws when Resend rejects the email', async () => {
    const rejecting = (async () => new Response('{"message":"domain not verified"}', { status: 403 })) as unknown as typeof fetch;
    await assert.rejects(createResendMailer('re_test', 'x@example.com', rejecting).sendPasswordResetCode('a@example.com', '123456'), /403/);
  });
});
