# Changelog

What changed in each version of Orbital, newest first, written for the people
who use it.  Versions follow `major.minor.patch`: a new feature bumps the
middle number, a fix bumps the last.  The automated data refreshes (launch data
twice a week, the satellite lists every four hours) do not change the version.

The version and build you are running are shown at the foot of the welcome
card (the **?** button reopens it).

## 0.4.0 — 15 November 2026

- **Orbital now serves its own satellite data.** Your browser used to download
  the satellite lists directly from CelesTrak, the free service that publishes
  them.  The site now fetches them itself every four hours and hands them to
  you from its own address.  A first visit downloads about 1.2 MB instead of
  about 9 MB, and no longer depends on CelesTrak answering at that moment.
- **Lighter return visits.** The app checks for new data with one tiny request
  and downloads the lists only when they have changed.
- Positions are computed from elements at most about five hours old
  (previously up to two); the difference is not visible.

## 0.3.0 — 15 November 2026

- **Satellites appear at once.** The app used to show an empty globe until the
  live satellite list had downloaded, and gave up after 15 seconds.  It now
  draws the satellites immediately from a saved copy and replaces them with the
  live list when that arrives, without the dots moving or your selection
  changing.  For about one visitor in four, the live list was not arriving in
  time at all.
- **Slow connections get live data.** Because nothing is waiting on it, the
  live list is now given 30 seconds to arrive.

## 0.2.0 — 14 November 2026

Changes made after watching the first few dozen visitors: most looked at the
welcome card and left without touching the globe.

- **The globe comes first.** A first visit no longer opens a full-screen card
  over a dimmed globe.  You see the satellites straight away, with a small card
  beside them giving the live count and three ways in: find the Space Station,
  watch the launch history, or take the tour.  The full welcome card is still
  behind the **?** button.
- **A link straight to the launch history.** Opening the app at `#timeline`
  starts the 1957 → today replay at once.
- **The launch timeline works without the side panel.** While it runs, the
  year, the count, play/pause and close sit on the globe — on a phone you no
  longer need the drawer open to use it.
- **Better pacing.** The replay takes about 40 seconds and spends a third of
  that on the years since 2019, where nearly everything happens, instead of
  one second on every year.
- **Fresher fallback data.** The satellite list bundled with the app, used when
  the live feed cannot be reached, is now refreshed every week, not every month.

## 0.1.0 — 13 November 2026

The first numbered version: everything Orbital did before versions were counted.

- **Every active satellite, live.** About 16,000 satellites from CelesTrak's
  active catalog, plus three large debris clouds, moving in real time on a 3D
  globe.  Tap one to follow it, or search by name or NORAD number.
- **Launch timeline.** Play the catalog forward from 1957 to today.
- **Close approaches.** See which pairs are within 5–25 km right now, and
  screen any satellite for close passes over the next 24 hours.
- **Ground station.** Drop a point on Earth to list the passes over it,
  including those visible to the naked eye, with an overhead sky chart.
- **Beyond Earth.** The solar system with planets, moons, comets, asteroid
  families and spacecraft; a Moon globe with landing sites; surface globes for
  the planets and larger moons.
- **Missions.** The story of spaceflight from Sputnik to this week; the last
  section updates itself as launches happen.
- **Installable.** Works as an app on Android and iPhone, and reopens without a
  connection after one visit.
- **Holds up on a bad day.** If the data feed is down it shows older elements;
  if a background task or the graphics view fails it recovers or offers a
  reload; if a newer version is published while it is open it offers a refresh.
- **Share and record.** Every view has a link; `?clip` gives a clean stage for
  recording the launch timeline.
