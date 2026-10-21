# Basis Universal transcoder

The viewer turns places' KTX2 textures into whatever compressed format the graphics card reads
with this transcoder (`basis_transcoder.js` + `basis_transcoder.wasm`), loaded by three.js's
`KTX2Loader` (see `src/ktx2.ts`).

It's the same transcoder three.js ships in `examples/jsm/libs/basis`, Basis Universal **v1_50_0**,
whose own prebuilt `basis_transcoder.wasm` is byte for byte the one three.js 0.186 has. It's
rebuilt here for one reason: the app's Content-Security-Policy allows WebAssembly
(`'wasm-unsafe-eval'`) but not JavaScript made from strings (`'unsafe-eval'`), and three.js's
build makes its function wrappers that way (embind's `new Function`). Under the policy its workers
fail, `KTX2Loader` never hears back, and a place with KTX2 textures never finishes opening. This
build adds `-s DYNAMIC_EXECUTION=0`, which makes embind use plain closures instead.

Built from <https://github.com/BinomialLLC/basis_universal> at tag `v1_50_0` with Emscripten
4.0.15 (the `emscripten/emsdk:4.0.15` image), after adding
`-s DYNAMIC_EXECUTION=0 -s EXPORTED_RUNTIME_METHODS=['HEAP8']` to the `LINK_FLAGS` in
`webgl/transcoder/CMakeLists.txt` (the wrapper reads `HEAP8`, which newer Emscripten doesn't export
unless asked; later Basis versions add it too):

```sh
emcmake cmake <basis_universal>/webgl/transcoder -DCMAKE_BUILD_TYPE=Release
emmake make
```

Basis Universal is © Binomial LLC, under the Apache License 2.0 (`LICENSE`).
