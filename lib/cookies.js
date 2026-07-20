function parseCookies(header = '') {
    const result = {};
    for (const part of String(header).split(';')) {
        const index = part.indexOf('=');
        if (index === -1) continue;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (!key) continue;
        try {
            result[key] = decodeURIComponent(value);
        } catch (_) {
            result[key] = value;
        }
    }
    return result;
}

function serializeCookie(name, value, options = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
    if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
    parts.push(`Path=${options.path || '/'}`);
    if (options.httpOnly !== false) parts.push('HttpOnly');
    if (options.secure) parts.push('Secure');
    parts.push(`SameSite=${options.sameSite || 'Strict'}`);
    return parts.join('; ');
}

module.exports = { parseCookies, serializeCookie };
