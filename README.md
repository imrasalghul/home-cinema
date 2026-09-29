# home-cinema

A self-hosted web interface for the media services you run. Browse and play movies and series from Plex, music from Navidrome, YouTube through Invidious, and live channels from TVHeadend. Plex handles sign-in and library metadata; the app streams local Plex media from mounted folders.

> **Status:** Personal-server software. You must configure and operate the upstream services yourself. This project does not include media, a hosted service, or third-party API credentials.

## Features

- Plex sign-in and library browsing, with movie and series details, progress, and subtitles.
- Navidrome music library, playback, and Genius lyrics lookup.
- YouTube search, video playback, comments and replies, related videos, channels, subscriptions, watchlist, and watched indicators through Invidious.
- Live TV channels and electronic programme guide from TVHeadend.
- Optional Seerr integration for movie and series search and requests.
- Docker deployment with read-only media mounts.

## Screenshots

### Series

![Series library with featured show and poster carousels](artifacts/series-library.png)

### Music

![Music album library](artifacts/music-library.png)

![Music playback bar with Genius lyrics panel](artifacts/music-lyrics.png)

### Live TV

![Live TV player and electronic programme guide](artifacts/live-tv.png)

### YouTube

![YouTube player with quality selector and related videos](artifacts/youtube-player.png)

## Services

| Service | Use | Configuration |
| --- | --- | --- |
| Plex Media Server | Required: sign-in, library metadata, user identity | `PLEX_SERVER_URL`, `PLEX_MACHINE_ID` |
| Navidrome | Required for Music | `NAVIDROME_URL`, `NAVIDROME_USERNAME`, `NAVIDROME_PASSWORD` |
| Invidious | Required for YouTube features | `INVIDIOUS_URL` |
| TVHeadend | Required for Live TV | `TVHEADEND_URL`, `TVHEADEND_USERNAME`, `TVHEADEND_PASSWORD` |
| Genius API | Optional: music lyrics | `GENIUS_ACCESS_TOKEN` |
| Seerr | Optional: requests | `SEERR_URL`, `SEERR_API_KEY` |

The application reads the configured Invidious API for YouTube search, metadata, comments, channels, and media stream information. Use an Invidious instance you trust and configure it according to that instance's documentation.

## Run the published Docker image

The Compose configuration uses `ghcr.io/imrasalghul/home-cinema:latest`. On a host with Docker Engine and the Compose plugin:

1. Clone this repository and enter its directory.
2. Copy `.env.example` to `.env` and replace the dummy values with your own service addresses and credentials. Set `SITE_NAME` and choose a unique, randomly generated `SESSION_SECRET`.
3. Make sure the Docker host can reach Plex, Navidrome, Invidious, and TVHeadend. Adjust the media mounts in `docker-compose.yml` to match the paths Plex reports.
4. Pull and start the published image:

   ```sh
   docker compose pull home-cinema
   docker compose up -d --no-build home-cinema
   ```

5. Open the address and port published by Compose, then sign in with Plex.

The Compose defaults mount `/media/library/movies` and `/media/library/tv` read-only and publish port `3210`. Change the host-side mount paths in `docker-compose.yml` for your server. Set `APP_PUBLIC_URL` to the browser-facing HTTPS URL when Plex sign-in must return to a public hostname. A reverse proxy or tunnel should forward to the Compose-published port.

## Build from source

To build the image locally instead of pulling it from GHCR, run `docker compose up -d --build home-cinema`.

## Local development

Requires Node.js 22 or later and pnpm. Plex media files must be accessible at the paths configured by Plex, either directly or through `PLEX_PATH_MAPPINGS`.

```sh
cp .env.example .env
pnpm install
pnpm dev
```

Open `http://localhost:5173`. The Vite development server proxies API requests to the local app server. Keep the development `.env` private; use only dummy credentials in examples and documentation.

## Configuration

All configuration is read by the server from `.env` or the process environment. `.env.example` contains dummy values only; replace them locally and never commit your `.env`.

| Variable | Purpose |
| --- | --- |
| `SITE_NAME` | Display name in the page title, header, Plex client identity, and Navidrome client field. |
| `SESSION_SECRET` | Secret used to sign session cookies and media URLs. Use a long random value. |
| `PLEX_SERVER_URL` | Base URL of the Plex Media Server. |
| `PLEX_MACHINE_ID` | Plex server machine identifier used to verify the configured server. |
| `PLEX_CLIENT_IDENTIFIER` | Optional stable identifier for this app in Plex. |
| `PLEX_PATH_MAPPINGS` | Optional JSON object mapping Plex file path prefixes to paths inside the container. |
| `MEDIA_ROOT` | Media root inside the container; defaults to `/media/library`. |
| `NAVIDROME_URL` | Navidrome base URL reachable from the app server. |
| `NAVIDROME_USERNAME` / `NAVIDROME_PASSWORD` | Navidrome account used for music API and streams. |
| `INVIDIOUS_URL` | Base URL of the Invidious instance. |
| `GENIUS_ACCESS_TOKEN` | Optional Genius API access token used for lyric search. Keep it server-side. |
| `TVHEADEND_URL` | TVHeadend base URL reachable from the app server. |
| `TVHEADEND_USERNAME` / `TVHEADEND_PASSWORD` | TVHeadend credentials. |
| `SEERR_URL` / `SEERR_API_KEY` | Optional Seerr server and API key. |
| `APP_PUBLIC_URL` | Public browser-facing app URL used for Plex authentication return navigation. |
| `APP_PORT` | Host port exposed by Docker Compose; defaults to `3210`. |

`PLEX_PATH_MAPPINGS` is useful when Plex reports paths such as `/mnt/media/movies` while the app sees `/media/library/movies`. Example:

```dotenv
PLEX_PATH_MAPPINGS={"/mnt/media/movies":"/media/library/movies","/mnt/media/tv":"/media/library/tv"}
```

## Security and privacy

- Run the app behind HTTPS when accessing it outside your trusted LAN.
- Keep `.env`, Plex tokens, service passwords, API keys, session data, and user profiles private. Do not put credentials in frontend code, issue reports, screenshots, or committed files.
- Use a unique `SESSION_SECRET`; changing it signs out existing sessions and invalidates signed Plex media URLs.
- The app requires a Plex session for its normal media routes and sends media responses as `private, no-store`. Live TV is not edge-cached.
- Casting uses short-lived bearer URLs so a receiver can access a stream without the browser's Plex cookie. Anyone who obtains an active cast URL can use it until the grant expires; do not share those URLs.
- Mount media read-only and restrict network access to the app and upstream services.

## Contributing

Bug reports and pull requests are welcome. Before sharing a reproduction, remove private server addresses, account names, media paths, cookies, session identifiers, and credentials from logs and screenshots. Add automated checks for changes where practical.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
