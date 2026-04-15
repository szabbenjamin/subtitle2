export interface FrontendBuildInfo {
  commit : string;
  builtAtUtc : string;
}

export const BUILD_INFO : FrontendBuildInfo = {
  commit: 'dev',
  builtAtUtc: 'local',
};
