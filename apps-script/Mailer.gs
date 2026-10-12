/**
 * Founders Office dashboard · sign-in code mailer
 * -----------------------------------------------
 * The dashboard calls this web app to email a one-time sign-in code to an approved person.
 * Emails go out from the Google account that owns this script (free: ~100/day on Gmail, 1,500/day on Workspace).
 *
 * Setup (once):
 *   1. Project Settings → Script properties → add MAILER_SECRET = a long random string (same value as the Cloudflare secret).
 *   2. Deploy → New deployment → type "Web app" → Execute as: Me → Who has access: Anyone → Deploy → copy the Web app URL.
 *   3. Put that URL in wrangler.toml as MAILER_URL and the secret in Cloudflare as MAILER_SECRET.
 *
 * Safety: without the exact secret nothing is sent, and only sign-in code emails can be sent — it cannot be used as a general mail relay.
 */
function doPost(e) {
  var out = function (o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); };
  try {
    var secret = PropertiesService.getScriptProperties().getProperty('MAILER_SECRET');
    var b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!secret || b.secret !== secret) return out({ ok: false, error: 'forbidden' });
    var to = String(b.to || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return out({ ok: false, error: 'bad address' });
    var subject = String(b.subject || '');
    if (!/^\d{6} is your Founders Office dashboard code$/.test(subject)) return out({ ok: false, error: 'only sign-in code emails are allowed' });
    if (MailApp.getRemainingDailyQuota() < 1) return out({ ok: false, error: 'daily email limit reached' });
    MailApp.sendEmail({ to: to, subject: subject, body: String(b.text || '').slice(0, 2000), htmlBody: String(b.html || '').slice(0, 5000) || undefined, name: 'Founders Office Dashboard' });
    return out({ ok: true, remaining: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return out({ ok: false, error: String((err && err.message) || err).slice(0, 200) });
  }
}

/** Optional: run once from the editor to approve permissions and send yourself a test email. */
function testMailer() {
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(), '123456 is your Founders Office dashboard code', 'Test: the mailer works. This code is not real.');
  Logger.log('Sent a test email to %s. Remaining quota today: %s', Session.getEffectiveUser().getEmail(), MailApp.getRemainingDailyQuota());
}
