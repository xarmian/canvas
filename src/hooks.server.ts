import { auth } from '$lib/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { building } from '$app/environment';
import { authenticateBearer, TOKEN_PREFIX } from '$lib/server/api-key';

export async function handle({ event, resolve }) {
	const session = await auth.api.getSession({
		headers: event.request.headers
	});

	if (session) {
		event.locals.session = session.session;
		event.locals.user = session.user;
	} else {
		event.locals.session = null;
		event.locals.user = null;
	}
	event.locals.apiKey = null;

	// Bearer-token path: ONLY runs when no session cookie is present so that
	// session auth always wins on UI-driven requests. Invalid / unknown
	// tokens fall through silently — the public `/c/{slug}` and
	// `/i/{shortId}` share pages must remain anonymous-reachable, so we
	// never 401 in the hook. Downstream `/api/v1/*` routes call
	// `requireApiKey()` and emit the right status themselves.
	//
	// SECURITY (Codex review round 1, P1): bearer auth deliberately does NOT
	// populate `locals.user`. The legacy session-gated layouts and `/api/*`
	// handlers (`/(app)/+layout.server.ts`, `/api/canvas/*`, etc.) use
	// `locals.user` as the auth gate. If bearer auth set `locals.user`, an
	// API-key holder could browse `/dashboard` and call session-only mutation
	// endpoints with no scope check. We expose API-key identity ONLY through
	// `locals.apiKey`; routes that need the owning user read `apiKey.userId`
	// after calling `requireApiKey()`.
	if (!session) {
		const authHeader = event.request.headers.get('authorization');
		if (authHeader?.startsWith(`Bearer ${TOKEN_PREFIX}`)) {
			const token = authHeader.slice('Bearer '.length);
			const result = await authenticateBearer(token);
			if (result) {
				event.locals.apiKey = result.apiKey;
			}
		}
	}

	return svelteKitHandler({ event, resolve, auth, building });
}
