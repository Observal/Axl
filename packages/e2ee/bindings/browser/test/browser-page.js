// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

import * as binding from "/package/loader/index.js";
import {
  runAllScenarios,
  runBoundaryScenario,
  runLifecycleScenario,
  runNegativeOpenMlsScenario,
  runPersistenceScenario,
  runStateScenario,
  testWorker,
} from "/test/scenario.js";

window.axlBrowserTest = Object.freeze({
  binding,
  runAllScenarios,
  runBoundaryScenario,
  runLifecycleScenario,
  runNegativeOpenMlsScenario,
  runPersistenceScenario,
  runStateScenario,
  testWorker,
});
