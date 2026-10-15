// Domains many unrelated people or businesses share (pure lists for
// lib/dedupe/key.ts). Matching by domain, an address at a free email provider
// never matches (two Gmail users are not one company), and a page on a shared
// site matches only the same page: facebook.com/joespizza is not
// facebook.com/acme. Sites that give each customer a subdomain listed on the
// Public Suffix List (acme.myshopify.com, acme.github.io, acme.netlify.app)
// already read as the customer's own domain and need no entry here.

export const FREE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'yahoo.ca', 'yahoo.fr', 'yahoo.de',
  'ymail.com', 'rocketmail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'live.com',
  'live.co.uk', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 'mail.com', 'zoho.com', 'zohomail.com', 'yandex.com', 'yandex.ru',
  'mail.ru', 'qq.com', '163.com', '126.com', 'fastmail.com', 'hey.com', 'tutanota.com', 'tuta.io', 'hushmail.com',
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net', 'charter.net',
  'orange.fr', 'free.fr', 'laposte.net', 'libero.it', 'btinternet.com', 'sky.com', 't-online.de', 'rediffmail.com',
  'naver.com', 'hanmail.net', 'seznam.cz', 'wp.pl', 'o2.pl',
]);

export const SHARED_SITE_DOMAINS: ReadonlySet<string> = new Set([
  // Social profiles and link pages.
  'facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'linkedin.com', 'lnkd.in', 'twitter.com', 'x.com', 't.co',
  'youtube.com', 'youtu.be', 'tiktok.com', 'pinterest.com', 'threads.net', 'snapchat.com', 'reddit.com',
  'tumblr.com', 'linktr.ee', 'beacons.ai', 'bio.link', 'about.me', 'behance.net', 'dribbble.com', 'vimeo.com',
  'soundcloud.com', 'spotify.com', 'twitch.tv', 'discord.gg', 'discord.com', 'patreon.com', 'wa.me',
  'whatsapp.com', 't.me', 'telegram.me',
  // Listings, maps and reviews.
  'google.com', 'goo.gl', 'g.page', 'g.co', 'yelp.com', 'tripadvisor.com', 'foursquare.com', 'yellowpages.com',
  'bbb.org', 'nextdoor.com', 'angi.com', 'houzz.com', 'thumbtack.com', 'crunchbase.com', 'wellfound.com',
  'angel.co', 'glassdoor.com', 'indeed.com', 'zoominfo.com', 'producthunt.com', 'apple.com',
  // Site builders and blogs that host customers under their own domain.
  'substack.com', 'medium.com', 'wordpress.com', 'squarespace.com', 'weebly.com', 'wix.com', 'godaddysites.com',
  'business.site', 'ueniweb.com', 'hubspotpagebuilder.com', 'notion.so', 'github.com', 'gitlab.com',
  'bitbucket.org',
  // Shops, events and short links.
  'etsy.com', 'amazon.com', 'ebay.com', 'shopify.com', 'calendly.com', 'eventbrite.com', 'meetup.com',
  'gofundme.com', 'bit.ly', 'tinyurl.com', 'ow.ly', 'buff.ly', 'rebrand.ly',
]);
