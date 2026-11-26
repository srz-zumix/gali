// Messages from gali/gcloud that signing in again can fix.
const AUTH_ERROR = /could not find default credentials|invalid_grant|invalid_rapt|reauth|cannot fetch token|insufficient authentication scopes|access_token_scope_insufficient|login required|gali auth login/i;

export function isAuthError(message) {
    return Boolean(message) && AUTH_ERROR.test(String(message));
}
