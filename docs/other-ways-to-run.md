# Other ways to run Cubex

The [one-line installer](../README.md#install) is the easiest way. Everything in the README also applies to these, apart from where settings and data live and how you reset the password.

## Coolify

If you run [Coolify](https://coolify.io), it can host Cubex with nothing installed on the server by hand:

1. In a project, add a new resource: **Public Repository**, paste this repository's URL, choose the **Docker Compose** build pack, then **Deploy**.
2. When the deploy finishes, open the **Environment Variables** tab and copy `SERVICE_PASSWORD_CUBEX`. That's your password. Coolify generated it before the app went live, so nobody can claim your install before you do.
3. Open the address Coolify gave the app and sign in. You can change the password in **Settings**.

To use your own domain, enter it in the `cubex` service's domain field as `https://cubex.example.com:3002`. The `:3002` only tells Coolify which container port to send traffic to; people still visit `https://cubex.example.com`. The address Coolify generates uses plain HTTP unless your server has a wildcard domain, so set a real domain before you put real data in. Coolify handles HTTPS for you.

The first build needs about 1.5 GB of free memory; on a small server, add swap or use a Coolify build server. Your data lives in the `cubex-data` volume (**Persistent Storage**), which redeploys keep. Settings are under **Environment Variables**: the ones listed in `docker-compose.yaml` are already there, and Coolify passes nothing else to the app. To reset the password, run `npm run reset-password` in the app's **Terminal** tab.

## Docker

```bash
git clone https://github.com/gurmohitghuman/cubex.git && cd cubex
docker compose up -d
```

Open http://localhost:3002 and choose a password. Settings go under `environment:` in `docker-compose.yaml`, your data lives in the `cubex-data` volume, and `docker compose exec cubex npm run reset-password` resets the password. On a server, make the two changes in [Docker instead of the installer](self-hosting.md#docker-instead-of-the-installer) first.

## From source

Needs Node.js 22.6 or newer.

```bash
git clone https://github.com/gurmohitghuman/cubex.git && cd cubex
npm install
npm run build
NODE_ENV=production npm start
```

Open http://localhost:3002. Settings go in `server/.env` (copy [server/.env.example](../server/.env.example)), your data lives in `server/data/`, and `npm run reset-password` resets the password. Unless you set `HOST`, Cubex listens on every network interface here.
