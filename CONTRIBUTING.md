# Contributing to PixelPlanetsPlus

Howdy, welcome to the planet foundry! Whether you're here to report a bug, donate an idea, or sling some shader math, you are most welcome among these tiny dithered worlds. This is a one-person passion project standing (and wobbling a bit) on the shoulders of two other people's excellent work, so every decent contribution genuinely matters and is genuinely appreciated!

**Heads Up!** The whole engine is mid-rewrite (WebGL/GLSL → WebGPU/TSL, see the [Flight Plan](README.md#flight-plan)). Until that settles, please open an [Issue](../../issues) before starting anything big, so your weekend doesn't collide with mine.

## The Easy Ways to Help

- **Found a bug?** Open an [Issue](../../issues). Include your browser, your GPU, and the seed if it's seed-specific. Screenshots adored!
- **Got an idea?** Also an Issue! Tell me what you want floating in the void and why it would be cool. New planet types, star types, weird space objects — the catalog has infinite shelf space.
- **Made a gorgeous little world?** Share the seed! Standouts may get featured, with credit, always.
- **Typos, wonky text, busted sliders, broken links?** All fair game. Small PRs for small problems are just dandy.

## Contributing Code

A few things to know before you dive into the deep black void of space with me:

1. **Getting Up & Running:** Your usual `npm install`, then `npm run dev`, and Vite serves the site with hot reload. `npm run typecheck` & `npm run build` must both pass before a PR; the build won't bundle if the types don't check. Gotta be checkin.
2. **Strict TypeScript with No Escape Hatches:** If you're fighting the compiler, the types are usually trying to tell you something about r139-era code meeting a modern API. I'm handling it, promise!
3. **Sacred Pixels:** Quantized UVs, chunky dither at every band boundary, flat palette ramps. A contribution that smooths, blurs, or anti-aliases the beloved aesthetic will be lovingly turned away.
4. **Determinism Is Law.** Every random decision must flow from the seeded RNG so identical seeds render identical worlds on every machine. `Math.random()` in rendering code is an automatic rethink.
5. **Please Match the Code Style!** Sparse comments that explain *why* not *what*. When in doubt, imitate the nearest existing file or imbibe a bunch of legal cannabis products and try to imitate me.
6. **Mind Ya Sources!** Only contribute code you wrote or that carries an MIT-compatible license. Reimplementing math from a description is fine but pasting license-encumbered code is not. If an LLM helped you write it, I won't be too mad, but I'll vet it extra hard.

Keep PRs focused! One idea per PR beats a mega-PR, and a few sentences about what changed and why helps me merge your cool space stuff faster.

## The Legal Bit (It's Tiny)

PixelPlanetsPlus is and always will be [MIT](LICENSE.md). By contributing, you agree your contribution lands under MIT like everything else here — free for anyone, forever, including you, including commercially. That's the whole deal. Deep-Fold gave these planets to the world with open hands and this repo keeps that spirit intact.

## Contact Me (If You Dare)

- Discord: **XYAgain**
- Email: **sam@tkb.band**

<p align="center">🌎🧡🪐</p>
