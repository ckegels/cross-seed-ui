import { ListTree } from "lucide-react";
import { useApi } from "../hooks.ts";
import { PageHeader } from "../Layout.tsx";
import { Link } from "../router.tsx";
import { instanceColor, useApp } from "../state.tsx";
import { Badge, Card, Empty, ErrorBox, Notice, Spinner } from "../ui/index.tsx";

interface Row {
	id: number;
	name: string;
	privacy: string;
	enable: boolean;
	tags: number[];
	implementation: string;
	usedBy: number[];
}

export function IndexersPage() {
	const { instances } = useApp();
	const status = useApi<{ configured: boolean; url?: string }>("/api/prowlarr");
	const list = useApi<{ indexers: Row[]; tags: { id: number; label: string }[] }>(status.data?.configured ? "/api/prowlarr/indexers" : null);
	const tagName = (id: number) => list.data?.tags.find((t) => t.id === id)?.label ?? `#${id}`;
	return (
		<>
			<PageHeader title="Indexers" icon={<ListTree size={20} />} subtitle="Your Prowlarr indexers and which cross-seed instance uses them" />
			{!status.data ? (
				<Spinner />
			) : !status.data.configured ? (
				<Card>
					<Empty icon={<ListTree size={28} />} title="Prowlarr is not connected">
						Connect it in <Link to="/settings/prowlarr" className="text-accent hover:underline">Settings → Prowlarr</Link> to manage indexers for every instance from one list.
					</Empty>
				</Card>
			) : (
				<div className="space-y-3">
					<Notice tone="accent">
						To add or remove indexers for an instance, open the instance's <b>Indexers</b> tab. Per instance you can pick indexers by hand, by Prowlarr tag, or take every enabled one.
					</Notice>
					{list.error && <ErrorBox error={list.error} retry={list.reload} />}
					{!list.data ? (
						<Spinner />
					) : (
						<Card padded={false}>
							<div className="overflow-x-auto">
								<table className="w-full text-sm">
									<thead>
										<tr className="border-b border-line text-left text-xs text-ink-3">
											<th className="px-4 py-2 font-medium">Indexer</th>
											<th className="px-3 py-2 font-medium">Type</th>
											<th className="px-3 py-2 font-medium">Tags</th>
											{instances.map((i) => (
												<th key={i.id} className="px-3 py-2 font-medium text-center whitespace-nowrap">
													<span className="inline-flex items-center gap-1.5">
														<span className="inline-block size-2.5 rounded-[3px]" style={{ background: instanceColor(i.id) }} />
														{i.name}
													</span>
												</th>
											))}
										</tr>
									</thead>
									<tbody className="divide-y divide-line">
										{list.data.indexers.map((r) => (
											<tr key={r.id} className={r.enable ? "" : "opacity-60"}>
												<td className="px-4 py-2">
													<div className="font-medium">{r.name}</div>
													<div className="text-[11px] text-ink-3">
														Prowlarr #{r.id}
														{!r.enable && " · disabled"}
													</div>
												</td>
												<td className="px-3 py-2">
													<Badge tone={r.privacy === "private" ? "accent" : "neutral"}>{r.privacy}</Badge>
												</td>
												<td className="px-3 py-2">
													<div className="flex flex-wrap gap-1">
														{r.tags.map((t) => (
															<Badge key={t}>{tagName(t)}</Badge>
														))}
													</div>
												</td>
												{instances.map((i) => (
													<td key={i.id} className="px-3 py-2 text-center">
														{r.usedBy.includes(i.id) ? <Badge tone="good">in use</Badge> : <span className="text-ink-3">–</span>}
													</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</Card>
					)}
				</div>
			)}
		</>
	);
}
