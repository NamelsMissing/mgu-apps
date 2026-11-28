# Third-party notices

Der Ordner `kit/` enthält Teile aus [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps), verwendet unter der MIT-Lizenz. Die ursprünglichen Urheberrechts- und Lizenzhinweise werden nachfolgend beibehalten.

## idrive7-apps – MIT License

MIT License

Copyright (c) 2026 cauliflowermossgrape
Copyright (c) 2026 小白151 (GitHub: JackieZ123430), Chinese translation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


## Equalizer DSP

The new biquad implementation uses the mathematical peaking-EQ formulae
documented in the W3C Audio EQ Cookbook by Robert Bristow-Johnson:
https://www.w3.org/TR/audio-eq-cookbook/. The filter, service and streaming
client are new repository code; no Moonride, BMW DSP binary or firmware audio
code is redistributed. Existing MGU App Kit runtime assets retain their
previous notices.

## Eco Coach

`apps/eco_coach/fuel.js` (class `Flow`, the fuel-injection counter with its learned
scale) and the signal scalings in `apps/eco_coach/decode.js` follow the Live Data app of
[cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps),
used under the MIT License above. The consumption model, the trip score, the interactive
test and the simulated car are new repository code.
