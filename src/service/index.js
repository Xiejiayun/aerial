import {
  SERVICE_LABEL,
  WIN_TASK_NAME,
  aerialLogPath,
  buildSchtasksArgs,
  darwinWrapperPath,
  nodeBinary,
  plistPath,
  quoteSchtasksTR,
  renderDarwinWrapper,
  renderPlist,
  renderWindowsWrapper,
  stdioLogPath,
  winWrapperPath
} from "./wrapper-render.js";
import { classifyHealth } from "./health.js";
import { parseWrapperLogValues, parseWrapperPaths, wrapperBlock } from "./status.js";

export { renderPlist, renderDarwinWrapper, renderWindowsWrapper, buildSchtasksCreateArgs } from "./wrapper-render.js";
export { serviceInstall, serviceStart, serviceStop, serviceRestart, serviceUninstall } from "./lifecycle.js";
export { serviceStatus } from "./status.js";

export const _internal = {
  SERVICE_LABEL,
  WIN_TASK_NAME,
  plistPath,
  darwinWrapperPath,
  winWrapperPath,
  aerialLogPath,
  stdioLogPath,
  parseWrapperLogValues,
  parseWrapperPaths,
  wrapperBlock,
  buildSchtasksArgs,
  quoteSchtasksTR,
  classifyHealth,
  nodeBinary
};
