# Changelog

What changed in each version of Orbital, newest first, written for the people
who use it.  Versions follow `major.minor.patch`.  Every release — a fix or a new
feature — bumps the last number only; the first two change when the owner
decides they should.  (0.2.0 to 0.6.0 each bumped the middle number for a
feature, before that was settled.)  The automated data refreshes (launch data
twice a week, the satellite lists every four hours) do not change the version.

The version and build you are running are shown at the foot of the welcome
card (the **?** button reopens it).

## 0.6.5 — 25 November 2026

- **A frozen globe now says so, and offers a way out.** One kind of failure
  could leave the 3D view frozen with no message at all. It now shows the same
  "The 3D view stopped" card, with a Reload button, as other drawing failures.
- **That failure is now counted.** It was missing from the anonymous failure
  counts. It is counted like the others, with one more fixed label saying
  whether the drawing or Orbital's own per-frame code stopped. As before, no
  error text is sent and nothing about you or your device.

## 0.6.4 — 24 November 2026

- **A stopped 3D view now says what kind of failure it was.** When the drawing
  stops and the "The 3D view stopped" card appears, the anonymous count sent
  with it now records which view it was (Earth, the Moon, the solar system or a
  planet), a one-word kind of failure, and whether it happened at the start or
  later on. It still sends no error text and nothing about you or your device.
  It is there so the cause can be found and fixed.

## 0.6.3 — 19 November 2026

- **The source code is linked.** The end of the guide (the **?** button) now
  links to where Orbital's code lives, for anyone who wants to see how it
  works.

## 0.6.2 — 16 November 2026

- **Under the hood:** the library that does the orbit maths was updated from
  version 5 to version 7.  Every position comes out the same — checked for
  all 32,672 objects — so nothing should look different.

## 0.6.1 — 16 November 2026

- **Data sources are credited on screen.** The foot of the side panel now
  names and links Space-Track and CelesTrak, instead of only the end of the
  guide.

## 0.6.0 — 16 November 2026

- **What is this satellite?** Selecting a satellite now shows, where known, a
  real photo of it, a one-line description, what it is or was for, and a link
  to its Wikipedia article.  For inactive satellites it also says when they
  are believed to have stopped working.
- About 630 of the satellites now in orbit have photos — the well-known
  ones; nearly all the rest have at least a purpose.  Debris and rocket
  bodies have none of this.
- Photos come from Wikimedia Commons with their author and licence; details
  from Wikidata and from Jonathan McDowell's GCAT.

## 0.5.1 — 16 November 2026

- **Reloading always gets the latest satellite data.** The app used to skip
  the check if it had looked in the last half hour, so two devices could show
  different catalogues.  It now asks on every load.
- **The data's date is shown** under the version number on the welcome card
  (the **?** button).
- **Search puts working satellites first**, and labels anything that is not
  one.

## 0.5.0 — 15 November 2026

- **Everything in orbit, not just the working satellites.** Orbital now also
  shows inactive satellites (some up since the 1950s), spent rocket bodies and
  all tracked debris — about 32,700 objects instead of 18,500.  Each kind has
  its own colour and its own switch in the side panel, and its own filter in
  the catalog.
- **Counts still mean what they said.** The first-visit card, the launch
  timeline and recording mode count active satellites only, as before.
- **A note on close approaches.** The list now says plainly that it comes from
  public orbit data and illustrates crowding; it is not a collision warning.
- **Pass predictions skip debris**, so the scan covers satellites and rocket
  bodies — the things you can actually see.
- Orbit data now comes from Space-Track.org (U.S. Space Command), with
  CelesTrak's list, checked once a day, deciding which satellites are active.

## 0.4.1 — 15 November 2026

- **Satellites launched since July 2026 now appear.** Catalogue numbers passed
  99,999 on 11 July, and the data format Orbital was reading cannot hold six
  digits, so about 1,400 newer objects — four months of launches — were
  silently missing.  They are now included, and can be searched and linked to
  by their real numbers.

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
