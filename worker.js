import HTML from './index.html';

const ADMIN_ACTIONS = {
  '/start': { gameActive: true },
  '/stop': { gameActive: false },
  '/reset': { gameActive: false, seats: null }
};
const SEAT_COUNT = 1000;
const CLAIM_ACTION = 'seat_claim';
const ADMIN_AUTH_DURATION_MS = 10 * 60 * 1000;
const PARTICIPANT_EMAILS_PATH = 'participantEmails';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/config') {
        return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || '' });
      }
      const syncProfile = request.method === 'POST' && url.pathname === '/profile/sync';
      if (syncProfile || (url.pathname === '/profile' && ['GET', 'PUT'].includes(request.method))) {
        return await handleProfile(request, env, ctx, syncProfile);
      }
      if (request.method === 'POST' && url.pathname === '/claim') {
        return await handleClaim(request, env, ctx, url.hostname);
      }
      if ((request.method === 'POST' && (url.pathname === '/admin/verify' || Object.hasOwn(ADMIN_ACTIONS, url.pathname))) ||
          (request.method === 'GET' && url.pathname === '/admin/leaderboard-emails')) {
        return await handleAdmin(request, env, url.pathname);
      }
    } catch {
      return error('서버에서 처리하지 못했습니다. 잠시 후 다시 시도하세요.', 500);
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return error('요청한 경로를 찾을 수 없습니다.', 404);
  }
};

function bearerToken(request) {
  const authorization = request.headers.get('Authorization') || '';
  return authorization.match(/^Bearer (\S+)$/)?.[1];
}

async function authenticate(idToken, env) {
  if (!idToken) return null;
  const payload = idToken.match(/^[\w-]+\.([\w-]+)\.[\w-]+$/)?.[1];
  if (!payload) return null;

  const lookup = new URL('https://identitytoolkit.googleapis.com/v1/accounts:lookup');
  lookup.searchParams.set('key', env.FIREBASE_API_KEY);
  const authRes = await fetch(lookup, jsonRequest('POST', { idToken }));
  if (authRes.status === 400 || authRes.status === 401 || authRes.status === 403) return null;
  if (!authRes.ok) throw new Error('Firebase Authentication unavailable');
  const account = await authRes.json();
  const user = account.users?.[0];
  if (!user?.localId || user.disabled) return null;

  // Firebase has accepted the ID token. Read its sign-in provider and project.
  const bytes = Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  const claims = JSON.parse(new TextDecoder().decode(bytes));
  if (claims.aud !== env.FIREBASE_PROJECT_ID ||
      claims.iss !== `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}` ||
      claims.sub !== user.localId) {
    return null;
  }
  return {
    uid: user.localId,
    provider: claims.firebase?.sign_in_provider,
    authTime: claims.auth_time,
    email: user.emailVerified === true ? readEmail(user.email) : null
  };
}

async function handleAdmin(request, env, path) {
  const userToken = bearerToken(request);
  const adminToken = request.headers.get('X-Admin-Token');
  if (!userToken || !adminToken) return error('관리자 인증이 필요합니다.', 403);
  if (!env.ADMIN_UID) return error('관리자 계정 설정이 필요합니다.', 503);

  const [user, admin] = await Promise.all([authenticate(userToken, env), authenticate(adminToken, env)]);
  const now = Date.now();
  const authTime = admin?.authTime * 1000;
  const expiresAt = authTime + ADMIN_AUTH_DURATION_MS;
  if (user?.provider !== 'google.com' || admin?.provider !== 'password' || admin.uid !== env.ADMIN_UID ||
      !Number.isInteger(admin.authTime) || authTime <= 0 || authTime > now || expiresAt <= now) {
    return error('관리자 인증이 필요합니다.', 403);
  }

  if (path === '/admin/verify') return json({ expiresAt, serverTime: now });
  if (path === '/admin/leaderboard-emails') return await handleLeaderboardEmails(env, expiresAt);

  const result = await fetch(databaseUrl(env), jsonRequest('PATCH', ADMIN_ACTIONS[path]));
  if (!result.ok) return error('게임 상태를 변경하지 못했습니다.', 502);
  return json({ success: true });
}

async function handleLeaderboardEmails(env, expiresAt) {
  const message = '참가자 이메일을 불러오지 못했습니다.';

  try {
    const seatsResponse = await fetch(databaseUrl(env, 'seats'));
    if (!seatsResponse.ok) return error(message, 502);
    const seats = await seatsResponse.json();
    const uids = new Set();
    for (const seat of Object.values(seats ?? {})) {
      if (typeof seat?.name === 'string' && typeof seat.playerId === 'string' && seat.playerId) {
        uids.add(seat.playerId);
      }
      if (uids.size === SEAT_COUNT) break;
    }

    const emails = [];
    if (uids.size) {
      const response = await fetch(databaseUrl(env, PARTICIPANT_EMAILS_PATH));
      if (!response.ok) return error(message, 502);
      const records = (await response.json()) ?? {};
      for (const uid of uids) {
        const email = Object.hasOwn(records, uid) ? readEmail(records[uid]) : null;
        if (email) emails.push({ uid, email });
      }
    }
    if (Date.now() >= expiresAt) return error('관리자 인증이 만료되었습니다.', 403);
    return json({ emails });
  } catch {
    return error(message, 502);
  }
}

async function saveParticipantEmail(env, { uid, email }) {
  try {
    const url = databaseUrl(env, `${PARTICIPANT_EMAILS_PATH}/${encodeURIComponent(uid)}`);
    const response = await fetch(url, email ? jsonRequest('PUT', email) : { method: 'DELETE' });
    if (!response.ok) console.warn('Participant email sync failed', response.status);
  } catch {
    console.warn('Participant email sync failed');
  }
}

async function handleProfile(request, env, ctx, syncProfile) {
  const user = await authenticate(bearerToken(request), env);
  if (user?.provider !== 'google.com') return error('Google 로그인이 필요합니다.', 401);

  const url = databaseUrl(env, `profiles/${encodeURIComponent(user.uid)}`);
  if (syncProfile) ctx.waitUntil(saveParticipantEmail(env, user));
  if (request.method !== 'PUT') {
    const result = await fetch(url);
    if (!result.ok) return error('계정 설정을 불러오지 못했습니다.', 502);
    return json({ profile: readProfile(await result.json()) });
  }

  const profile = readProfile(await request.json().catch(() => null));
  if (!profile) return error('닉네임은 1~20자로 입력하고 좌석 색상을 선택하세요.', 400);
  const result = await fetch(url, jsonRequest('PUT', profile));
  if (!result.ok) return error('계정 설정을 저장하지 못했습니다.', 502);
  return json({ profile });
}

async function handleClaim(request, env, ctx, hostname) {
  const { seatId, turnstileToken } = (await request.json().catch(() => null)) ?? {};
  if (!Number.isInteger(seatId) || seatId < 0 || seatId >= SEAT_COUNT) {
    return error('유효한 좌석을 선택하세요.', 400);
  }
  if (typeof turnstileToken !== 'string' || !turnstileToken.trim() || turnstileToken.length > 2048) {
    return error('사람 확인을 완료한 뒤 신청하세요.', 400);
  }
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY) {
    return error('사람 확인 설정을 사용할 수 없습니다.', 503);
  }

  const user = await authenticate(bearerToken(request), env);
  if (user?.provider !== 'google.com') return error('Google 로그인이 필요합니다.', 401);

  const profileRes = await fetch(databaseUrl(env, `profiles/${encodeURIComponent(user.uid)}`));
  if (!profileRes.ok) return error('계정 설정을 불러오지 못했습니다.', 502);
  const profile = readProfile(await profileRes.json());
  if (!profile) return error('계정 설정에서 닉네임과 색상을 먼저 저장하세요.', 422);

  const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',
    jsonRequest('POST', { secret: env.TURNSTILE_SECRET_KEY, response: turnstileToken }));
  if (!verifyRes.ok) return error('사람 확인 서비스에 연결하지 못했습니다.', 502);
  const verification = await verifyRes.json();
  if (verification.success !== true ||
      verification.action !== CLAIM_ACTION || verification.hostname !== hostname) {
    return error('사람 확인에 실패했습니다. 다시 확인한 뒤 신청하세요.', 403);
  }

  const activeRes = await fetch(databaseUrl(env, 'gameActive'));
  if (!activeRes.ok) return error('게임 상태를 확인하지 못했습니다.', 502);
  if (await activeRes.json() !== true) return error('게임이 진행 중일 때 신청할 수 있습니다.', 403);

  const seat = {
    name: profile.nickname,
    color: profile.color,
    playerId: user.uid,
    claimedAt: { '.sv': 'timestamp' }
  };
  const result = await fetch(databaseUrl(env, `seats/${seatId}`), {
    ...jsonRequest('PUT', seat),
    headers: { 'Content-Type': 'application/json', 'If-Match': 'null_etag' }
  });
  if (result.status === 412) return error('이미 신청된 좌석입니다.', 409);
  if (!result.ok) return error('좌석을 저장하지 못했습니다.', 502);
  ctx.waitUntil(saveParticipantEmail(env, user));
  return json({ success: true });
}

function readEmail(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

function readProfile(value) {
  if (typeof value?.nickname !== 'string' || typeof value.color !== 'string') return null;
  const nickname = value.nickname.trim();
  if (!nickname || nickname.length > 20 || !/^#[0-9a-f]{6}$/i.test(value.color)) return null;
  return { nickname, color: value.color.toLowerCase() };
}

function databaseUrl(env, path = '') {
  if (!env.FIREBASE_SECRET) throw new Error('Missing FIREBASE_SECRET');
  const url = new URL(`${env.FIREBASE_DB_URL.replace(/\/$/, '')}/${path}.json`);
  url.searchParams.set('auth', env.FIREBASE_SECRET);
  return url;
}

function jsonRequest(method, body) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function error(message, status) {
  return json({ error: message }, status);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
