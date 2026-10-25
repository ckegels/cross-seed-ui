import { useState } from "react";
import { dateTime } from "../../format.ts";
import { useApi } from "../../hooks.ts";
import { Badge, Card, Pager, Spinner } from "../../ui/index.tsx";

interface AuditRow {
	id: number;
	ts: number;
	username: string | null;
	ip: string | null;
	action: string;
	instance_name: string | null;
	detail: string | null;
	ok: number;
}

export function AuditSection() {
	const [offset, setOffset] = useState(0);
	const { data } = useApi<{ rows: AuditRow[]; total: number; limit: number }>(`/api/audit?limit=100&offset=${offset}`, { interval: 30_000 });
	return (
		<Card title="Audit log" subtitle="Every sign-in and every change, with who and from where" padded={false}>
			{!data ? (
				<Spinner />
			) : (
				<>
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-y border-line text-left text-xs text-ink-3">
									<th className="px-4 py-2 font-medium">When</th>
									<th className="px-3 py-2 font-medium">Who</th>
									<th className="px-3 py-2 font-medium">Action</th>
									<th className="px-4 py-2 font-medium">Details</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-line">
								{data.rows.map((r) => (
									<tr key={r.id}>
										<td className="px-4 py-2 whitespace-nowrap text-xs text-ink-3">{dateTime(r.ts)}</td>
										<td className="px-3 py-2 whitespace-nowrap">
											{r.username ?? "–"}
											<div className="text-[11px] text-ink-3">{r.ip}</div>
										</td>
										<td className="px-3 py-2 whitespace-nowrap">
											<Badge tone={r.ok ? (r.action.includes("failed") ? "warning" : "neutral") : "critical"}>{r.action}</Badge>
											{r.instance_name && <div className="text-[11px] text-ink-3 mt-0.5">{r.instance_name}</div>}
										</td>
										<td className="px-4 py-2 text-xs text-ink-2 break-words max-w-[32rem]">{r.detail}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<div className="flex justify-end p-3">
						<Pager offset={offset} limit={100} total={data.total} onChange={setOffset} />
					</div>
				</>
			)}
		</Card>
	);
}
