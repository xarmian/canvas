-- Seed the public landing demo canvas at the reserved /c/crypto-lp-card slug.
--
-- TASK-118 — runnable as:
--
--   psql "$DATABASE_URL" -f scripts/seed-crypto-lp-card.sql
--
-- No variables to pass. The CTE picks the earliest user (the operator)
-- as the owner. If you'd rather pin to a specific admin, edit the
-- `owner` CTE below — e.g. `WHERE email = 'you@example.com'`.
--
-- Re-runnable: ON CONFLICT (slug) DO NOTHING — second run is a no-op.
-- To force a re-seed, DELETE FROM canvases WHERE slug='crypto-lp-card'
-- first.
--
-- The slug `crypto-lp-card` is reserved in src/lib/server/slug.ts so users
-- cannot publish over it. That reservation is also why this seed exists:
-- the in-product "Use this template" flow would auto-derive
-- `crypto-lp-card-2` instead of taking the demo URL.

BEGIN;

WITH owner AS (
    -- First user wins. On a single-operator self-host that's the
    -- operator's account; on a multi-user instance, change this to
    -- pin a specific admin (e.g. `WHERE email = ...`).
    SELECT id FROM "user" ORDER BY created_at ASC LIMIT 1
)
INSERT INTO canvases (
    user_id, name, slug, width, height,
    background_type, background_value, template_json, published
)
SELECT
    owner.id,
    'Crypto LP card',
    'crypto-lp-card',
    1200, 630,
    'color', '#0f172a',
    $lp${"version":"1.0","objects":[{"type":"Rect","left":0,"top":0,"width":1200,"height":6,"fill":"#14b8a6"},{"type":"Image","left":60,"top":50,"width":80,"height":80,"src":"data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Ccircle%20cx%3D%2232%22%20cy%3D%2232%22%20r%3D%2230%22%20fill%3D%22%2364748b%22%2F%3E%3Ctext%20x%3D%2232%22%20y%3D%2242%22%20font-size%3D%2232%22%20font-family%3D%22sans-serif%22%20font-weight%3D%22700%22%20text-anchor%3D%22middle%22%20fill%3D%22%23ffffff%22%3E%3F%3C%2Ftext%3E%3C%2Fsvg%3E","fallbackSrc":"data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Ccircle%20cx%3D%2232%22%20cy%3D%2232%22%20r%3D%2230%22%20fill%3D%22%2364748b%22%2F%3E%3Ctext%20x%3D%2232%22%20y%3D%2242%22%20font-size%3D%2232%22%20font-family%3D%22sans-serif%22%20font-weight%3D%22700%22%20text-anchor%3D%22middle%22%20fill%3D%22%23ffffff%22%3E%3F%3C%2Ftext%3E%3C%2Fsvg%3E","paramBindings":{"src":{"param":"tokenALogoUrl"}}},{"type":"Image","left":130,"top":50,"width":80,"height":80,"src":"data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Ccircle%20cx%3D%2232%22%20cy%3D%2232%22%20r%3D%2230%22%20fill%3D%22%2364748b%22%2F%3E%3Ctext%20x%3D%2232%22%20y%3D%2242%22%20font-size%3D%2232%22%20font-family%3D%22sans-serif%22%20font-weight%3D%22700%22%20text-anchor%3D%22middle%22%20fill%3D%22%23ffffff%22%3E%3F%3C%2Ftext%3E%3C%2Fsvg%3E","fallbackSrc":"data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Ccircle%20cx%3D%2232%22%20cy%3D%2232%22%20r%3D%2230%22%20fill%3D%22%2364748b%22%2F%3E%3Ctext%20x%3D%2232%22%20y%3D%2242%22%20font-size%3D%2232%22%20font-family%3D%22sans-serif%22%20font-weight%3D%22700%22%20text-anchor%3D%22middle%22%20fill%3D%22%23ffffff%22%3E%3F%3C%2Ftext%3E%3C%2Fsvg%3E","paramBindings":{"src":{"param":"tokenBLogoUrl"}}},{"type":"Textbox","left":240,"top":60,"width":200,"text":"USDC","fontFamily":"Inter","fontSize":40,"fontWeight":700,"fill":"#ffffff","textAlign":"right","paramBindings":{"text":{"param":"tokenA","default":"USDC"}}},{"type":"Textbox","left":450,"top":60,"width":30,"text":"/","fontFamily":"Inter","fontSize":40,"fontWeight":400,"fill":"#64748b","textAlign":"center"},{"type":"Textbox","left":490,"top":60,"width":200,"text":"ETH","fontFamily":"Inter","fontSize":40,"fontWeight":700,"fill":"#ffffff","textAlign":"left","paramBindings":{"text":{"param":"tokenB","default":"ETH"}}},{"type":"Textbox","left":240,"top":110,"width":400,"text":"24h","fontFamily":"Inter","fontSize":22,"fontWeight":500,"fill":"#94a3b8","textAlign":"left","paramBindings":{"text":{"param":"timeframe","default":"24h"}}},{"type":"Textbox","left":60,"top":220,"width":600,"text":"+12.50%","fontFamily":"Inter","fontSize":96,"fontWeight":700,"fill":"#22c55e","textAlign":"left","paramBindings":{"text":{"param":"gainPercent","default":"0.125","format":"signed-percent:2"}},"conditionalStyles":[{"when":{"param":"gainPercent","op":"<","value":"0"},"then":{"property":"fill","value":"#ef4444"}}]},{"type":"Textbox","left":60,"top":330,"width":600,"text":"$125.30","fontFamily":"Inter","fontSize":36,"fontWeight":600,"fill":"#22c55e","textAlign":"left","paramBindings":{"text":{"param":"pl","default":"125.30","format":"currency:USD"}},"conditionalStyles":[{"when":{"param":"gainPercent","op":"<","value":"0"},"then":{"property":"fill","value":"#ef4444"}}]},{"type":"Textbox","left":60,"top":430,"width":200,"text":"Entry","fontFamily":"Inter","fontSize":18,"fontWeight":500,"fill":"#94a3b8","textAlign":"left"},{"type":"Textbox","left":60,"top":460,"width":280,"text":"$0.10","fontFamily":"Inter","fontSize":32,"fontWeight":600,"fill":"#ffffff","textAlign":"left","paramBindings":{"text":{"param":"entry","default":"0.10","format":"crypto-price"}}},{"type":"Textbox","left":360,"top":430,"width":200,"text":"Mark","fontFamily":"Inter","fontSize":18,"fontWeight":500,"fill":"#94a3b8","textAlign":"left"},{"type":"Textbox","left":360,"top":460,"width":280,"text":"$0.22","fontFamily":"Inter","fontSize":32,"fontWeight":600,"fill":"#ffffff","textAlign":"left","paramBindings":{"text":{"param":"mark","default":"0.22","format":"crypto-price"}}},{"type":"Textbox","left":660,"top":430,"width":200,"text":"Volume","fontFamily":"Inter","fontSize":18,"fontWeight":500,"fill":"#94a3b8","textAlign":"left"},{"type":"Textbox","left":660,"top":460,"width":280,"text":"$1.2M","fontFamily":"Inter","fontSize":32,"fontWeight":600,"fill":"#ffffff","textAlign":"left","paramBindings":{"text":{"param":"volume","default":"1234567","format":"compact:1"}}},{"type":"Badge","left":940,"top":50,"label":"In Range","fill":"#10b981","fg":"#ffffff","padding":12,"fontFamily":"Inter","fontSize":20,"fontWeight":600,"paramBindings":{"label":{"param":"rangeLabel","default":"In Range"}},"conditionalStyles":[{"when":{"param":"range","op":"==","value":"edge"},"then":{"property":"fill","value":"#f59e0b"}},{"when":{"param":"range","op":"==","value":"out_of_range"},"then":{"property":"fill","value":"#ef4444"}}]},{"type":"Badge","left":940,"top":110,"label":"\u2605 Boosted","fill":"#7c3aed","fg":"#ffffff","padding":12,"fontFamily":"Inter","fontSize":18,"fontWeight":600,"visible":false,"conditionalStyles":[{"when":{"param":"boosted","op":"==","value":"true"},"then":{"property":"visible","value":"true"}}]},{"type":"Image","left":1080,"top":540,"width":60,"height":60,"src":"","paramBindings":{"src":{"param":"platformLogoUrl"}}}]}$lp$::jsonb,
    TRUE
FROM owner
ON CONFLICT (slug) DO NOTHING;

-- Verify (prints one row on success).
SELECT slug, name, width || 'x' || height AS dims, published,
       length(template_json::text) AS template_bytes
FROM canvases
WHERE slug = 'crypto-lp-card';

COMMIT;
