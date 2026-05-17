// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			session: import('better-auth').Session | null;
			user: import('better-auth').User | null;
			// Set by hooks.server.ts when a request carries a valid
			// `Authorization: Bearer ck_live_*` header AND no session
			// cookie is present. Session cookies take precedence; if
			// both are sent only the cookie path populates locals.
			apiKey: import('$lib/server/api-key').AuthenticatedApiKey | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
