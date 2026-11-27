# Third-Party Notices

KetchupE is distributed under the MIT License (see `LICENSE`). The application bundles the following third-party software for chart rendering. Their license texts ship with the app under `third-party-licenses/`.

## Apache ECharts 6.1.0

- License: Apache License 2.0 (`third-party-licenses/echarts/LICENSE`)
- Source: https://github.com/apache/echarts
- Used unmodified, bundled into the Electron main and worker scripts.

```
Apache ECharts
Copyright 2017-2026 The Apache Software Foundation

This product includes software developed at
The Apache Software Foundation (https://www.apache.org/).
```

## ZRender (ECharts rendering engine)

- License: BSD 3-Clause (`third-party-licenses/zrender/LICENSE`)
- Source: https://github.com/ecomfe/zrender
- Copyright (c) 2017, Baidu Inc. All rights reserved.

## plotkit-ts (peak detection)

- License: MIT, Copyright (c) 2026 the plotkit authors (`third-party-licenses/plotkit-ts/LICENSE`)
- Source: https://github.com/HoseungChoi51/tga_plot, branch `lib/plotkit-ts`, commit `18bfc289`, `src/peaks.ts`
- Copied unchanged into `electron/excel/peaks.ts`.

That file ports `savgol_filter`, `find_peaks` and `peak_prominences` from SciPy 1.18 (`scipy.signal`):

- License: BSD 3-Clause
- Copyright (c) 2001-2002 Enthought, Inc. 2003-2024, SciPy Developers. All rights reserved. (`third-party-licenses/scipy/LICENSE`)
