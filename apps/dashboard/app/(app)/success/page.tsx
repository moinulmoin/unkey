import { AreaChart } from "@/components/dashboard/charts";
import { Loading } from "@/components/dashboard/loading";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { getTenantId } from "@/lib/auth";
import { and, count, db, gte, isNotNull, schema, sql } from "@/lib/db";
import { stripeEnv } from "@/lib/env";
import { getQ1ActiveWorkspaces } from "@/lib/tinybird";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import Stripe from "stripe";
import { Chart } from "./chart";

export const revalidate = 60;

export default async function SuccessPage() {
  const e = stripeEnv();
  if (!e) {
    return <div>no stripe env</div>;
  }
  const stripe = new Stripe(e.STRIPE_SECRET_KEY, {
    apiVersion: "2023-10-16",
    typescript: true,
  });
  const tenantId = getTenantId();

  const workspace = await db.query.workspaces.findFirst({
    where: (table, { and, eq, isNull }) =>
      and(eq(table.tenantId, tenantId), isNull(table.deletedAt)),
  });

  if (!workspace?.features.successPage) {
    return notFound();
  }

  const allInvoices: Stripe.Invoice[] = [];
  let hasMore = true;
  let startingAfter: string | undefined = undefined;
  while (hasMore) {
    await stripe.invoices
      .list({
        starting_after: startingAfter,
        status: "paid",
      })
      .then((res) => {
        allInvoices.push(...res.data);
        hasMore = res.has_more;
        startingAfter = res.data.at(-1)?.id;
      });
  }

  const billableInvoices = allInvoices.filter(
    (invoice) =>
      invoice.total > 0 && invoice.created >= Math.floor(Date.now() / 1000) - 45 * 24 * 60 * 60,
  );
  let customers = 0;
  const customerIds = new Set();
  billableInvoices.forEach((invoice) => {
    if (!customerIds.has(invoice.customer)) {
      customers += 1;
      customerIds.add(invoice.customer);
    }
  });

  const activeWorkspaces = await getQ1ActiveWorkspaces({});
  const chartData = activeWorkspaces.data.map(({ time, workspaces }) => ({
    x: new Date(time).toLocaleDateString(),
    y: workspaces - (time >= 1708470000000 ? 160 : 0), // I accidentally added integration test workspaces to this
  }));
  const customerGoal = 6;
  const activeWorkspaceGoal = 300;

  const tables = {
    Workspaces: schema.workspaces,
    Apis: schema.apis,
    Keys: schema.keys,
    Permissions: schema.permissions,
    Roles: schema.roles,
    "Ratelimit Namespaces": schema.ratelimitNamespaces,
    "Ratelimit Overrides": schema.ratelimitOverrides,
  };

  const t0 = new Date("2024-01-01");
  return (
    <div>
      <div className="w-full">
        <PageHeader title="Success Metrics" description="Unkey success metrics" />
        <div className="mb-8 text-2xl font-semibold" />
        <Separator />
      </div>
      <div className="grid w-full grid-cols-3 gap-6 p-6">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Active Workspaces</CardTitle>
            <CardDescription>{`Current goal of ${activeWorkspaceGoal}`}</CardDescription>
          </CardHeader>
          <CardContent>
            <div>
              <AreaChart data={chartData} timeGranularity="day" tooltipLabel="Active Workspaces" />
            </div>
          </CardContent>
        </Card>

        <Card className="flex flex-col w-full h-fit">
          <CardHeader>
            <CardTitle>Paying Customers</CardTitle>
            <CardDescription>Current goal of {customerGoal}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mt-2 text-2xl font-semibold leading-none tracking-tight">
              {customers}
            </div>
            <div className="mt-4">
              <Progress value={(customers / customerGoal) * 100} />
            </div>
          </CardContent>
        </Card>
        {Object.entries(tables).map(([title, table]) => (
          <Suspense fallback={<Loading />}>
            <Chart
              title={title}
              t0={t0}
              query={() =>
                db
                  .select({
                    date: sql<string>`DATE(created_at) as date`,
                    count: count(),
                  })
                  .from(table)
                  .where(and(isNotNull(table.createdAt), gte(table.createdAt, t0)))
                  .groupBy(sql`date`)
                  .orderBy(sql`date ASC`)
                  .execute()
              }
            />
          </Suspense>
        ))}
      </div>
    </div>
  );
}
