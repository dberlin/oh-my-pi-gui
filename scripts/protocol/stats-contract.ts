/** Each real stats HTTP producer must satisfy the GUI type that reads it. */
import type * as Server from "omp-stats";
import type * as Gui from "../../src/shared/stats-types";
import type { Assert, Compatible, Wire } from "./contract";

export type Overview = Assert<
	Compatible<Gui.OverviewData, Wire<Pick<Server.DashboardStats, "overall" | "byAgentType" | "timeSeries">>>
>;
export type Models = Assert<
	Compatible<Gui.ModelsData, Wire<Pick<Server.DashboardStats, "byModel" | "modelSeries" | "modelPerformanceSeries">>>
>;
export type Costs = Assert<Compatible<Gui.CostsData, Wire<Pick<Server.DashboardStats, "costSeries">>>>;
export type Tools = Assert<Compatible<Gui.ToolsData, Wire<Server.ToolDashboardStats>>>;
export type Providers = Assert<Compatible<Gui.ProvidersData, Wire<Server.ProviderDashboardStats>>>;
export type ProviderWindows = Assert<Compatible<Gui.ProviderWindowsData, Wire<Server.ProviderWindowStats>>>;
export type Errors = Assert<Compatible<Gui.ErrorRow, Wire<Server.MessageStats>>>;
export type Folders = Assert<Compatible<Gui.FolderRow, Wire<Server.FolderStats>>>;
export type Gain = Assert<Compatible<Gui.GainData, Wire<Server.GainDashboardStats>>>;
// /api/stats/recent returns a bounded list, not a server pagination envelope.
export type Requests = Assert<Compatible<Gui.RequestRow[], Wire<Server.MessageStats[]>>>;
export type RequestDetail = Assert<Compatible<Gui.RequestDetail, Wire<Server.RequestDetails>>>;
export type Frustration = Assert<Compatible<Gui.FrustrationData, Wire<Server.FrustrationDashboardStats>>>;
export type Status = Assert<Compatible<Gui.LiveStatus, Wire<Server.LiveStatus>>>;
