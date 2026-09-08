# CROSSOVER

Enter two clubs, get every footballer in history who played for both — with the
years, appearances and goals of each spell, and which way the transfer went.

## Running it

Any static server will do; there is no build step and no API key.

```bash
python3 -m http.server 8931
```

Then open <http://localhost:8931>.

## Where the data comes from

Everything is queried live from **Wikidata** via its public SPARQL endpoint
(`query.wikidata.org`) — free, no key, CORS-enabled, and updated by the
community within days of a real transfer (Ferran Torres' 2026 move to PSG is
already in there).

The core of it is property `P54` ("member of sports team"), whose qualifiers
carry start date (`P580`), end date (`P582`), appearances (`P1350`) and goals
(`P1351`). Two direct joins find everyone who has a `P54` statement pointing at
both clubs.

| Need | Source |
|---|---|
| Club search | Wikidata `wbsearchentities` via `wikibase:mwapi`, inside SPARQL |
| Shared players + spells | SPARQL on `P54` and its qualifiers |
| Club crests | Wikipedia `pageimages`, falling back to Wikidata `P154` |
| Player portraits | Wikidata `P18` via Commons `Special:FilePath` |
| Club colours | Read from the crest's own pixels on a `<canvas>` |

### Things that were not obvious

- **Club type is unreliable.** FC Barcelona is *not* an instance of "association
  football club" on Wikidata. Filtering search by type silently loses major
  clubs, so search instead requires that *somebody has played for the item* —
  which also guarantees any result actually works in the main query.
- **Query shape matters enormously.** The first working version used
  `FILTER EXISTS` twice and took 21 s. Two plain joins do the same job in ~1 s.
- **Labels go missing.** Lionel Messi's item currently has no English label at
  all, so labels fall back through a chain of languages.
- **Crests are often non-free**, so they live on English Wikipedia rather than
  Commons — `P154` is empty for PSG, Real Madrid and Manchester United.
  Wikipedia's `pageimages` returns them.
- **Always request a thumbnail width.** Messi's raw portrait is 5 MB; the same
  image at `?width=220` is 30 KB.

## Design notes

Typeset in **Syne** (display) and **Chivo** / **Chivo Mono** (text and figures),
laid out like a printed almanac: warm newsprint stock, heavy rules, sharp
corners, an animated grain layer.

The palette is not fixed — it is sampled from the two crests at runtime, so
Barcelona × PSG is gold and navy while Beşiktaş × Galatasaray is red and gold.
Two guards keep badges readable: every crest sits on a paper plate (so
Juventus's black badge survives its black disc), and a badge that is essentially
white is detected and given an ink plate instead.

The shared count rolls up on digit reels. The reel window is sized from Syne's
measured metrics — widest digit advance 1.158em, ink 0.66em above the baseline
and 0.171em below — because `overflow:hidden` clips both axes and a guessed box
shears the numerals into E-shapes.

## Caveats

Coverage is community-maintained: strong for major clubs and the modern era,
thinner for lower divisions and pre-war football. Appearance and goal counts are
usually league-only and are missing on some spells. Only senior teams match —
reserve and youth sides (Barcelona B, Real Madrid Castilla) are separate items.
