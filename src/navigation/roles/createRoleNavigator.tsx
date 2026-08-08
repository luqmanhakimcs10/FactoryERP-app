/**
 * Factory that builds a role-specific navigator.
 *
 * Phase 1 gave every role a placeholder home. Phase 2 added the generic master
 * screens. Phase 3 gives the three order-spine roles (order taker, QA, floor
 * manager) a real home screen and their own business screens, while the remaining
 * roles keep the shell home until their phase arrives.
 */
import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AppHeader } from '../../components/ui/AppHeader';
import { RoleHomeScreen } from '../../screens/shared/RoleHomeScreen';
import { TaskQueueScreen } from '../../screens/shared/TaskQueueScreen';
import { MasterListScreen } from '../../screens/masters/MasterListScreen';
import { MasterFormScreen } from '../../screens/masters/MasterFormScreen';
import { MyOrdersScreen } from '../../screens/orderTaker/MyOrdersScreen';
import { NewOrderScreen } from '../../screens/orderTaker/NewOrderScreen';
import { OrderDetailScreen } from '../../screens/orderTaker/OrderDetailScreen';
import { OrderTakerDashboardScreen } from '../../screens/orderTaker/OrderTakerDashboardScreen';
import { ReturnsScreen } from '../../screens/orderTaker/ReturnsScreen';
import { QaDashboardScreen } from '../../screens/qa/QaDashboardScreen';
import { InspectionQueueScreen } from '../../screens/qa/InspectionQueueScreen';
import { StageTrackingQueueScreen } from '../../screens/qa/StageTrackingQueueScreen';
import { ClothInspectionScreen } from '../../screens/qa/ClothInspectionScreen';
import { OrderQaScreen } from '../../screens/qa/OrderQaScreen';
import { FloorManagerDashboardScreen } from '../../screens/floorManager/FloorManagerDashboardScreen';
import { OrdersBoxScreen } from '../../screens/floorManager/OrdersBoxScreen';
import { MachineBoxScreen } from '../../screens/floorManager/MachineBoxScreen';
import { LeaveBoxScreen } from '../../screens/floorManager/LeaveBoxScreen';
import { DamagesBoxScreen } from '../../screens/floorManager/DamagesBoxScreen';
import { JobCardScreen } from '../../screens/floorManager/JobCardScreen';
import { JobCardBuilderScreen } from '../../screens/floorManager/JobCardBuilderScreen';
import { JobCardReviewScreen } from '../../screens/floorManager/JobCardReviewScreen';
import { StageTrackingScreen } from '../../screens/floorManager/StageTrackingScreen';
import { PoQueueScreen } from '../../screens/procurement/PoQueueScreen';
import { PoDetailScreen } from '../../screens/procurement/PoDetailScreen';
import { NewPoScreen } from '../../screens/procurement/NewPoScreen';
import { StockHomeScreen } from '../../screens/storeManager/StockHomeScreen';
import { StockLedgerScreen } from '../../screens/storeManager/StockLedgerScreen';
import { GrnQueueScreen } from '../../screens/storeManager/GrnQueueScreen';
import { GrnDetailScreen } from '../../screens/storeManager/GrnDetailScreen';
import { MaterialIssueQueueScreen } from '../../screens/storeManager/MaterialIssueQueueScreen';
import { IssueDetailScreen } from '../../screens/storeManager/IssueDetailScreen';
import { StockAuditScreen } from '../../screens/storeManager/StockAuditScreen';
// ---- Store Manager restructure: PO / Inventory / Audit / Requests ----
import { StoreManagerHomeScreen } from '../../screens/storeManager/StoreManagerHomeScreen';
import { AddInventoryScreen } from '../../screens/storeManager/AddInventoryScreen';
import { StoreNewPoScreen } from '../../screens/storeManager/StoreNewPoScreen';
import { DailyAuditScreen } from '../../screens/storeManager/DailyAuditScreen';
import { AuditDetailScreen } from '../../screens/storeManager/AuditDetailScreen';
import {
  StorePoSectionScreen,
  StoreInventorySectionScreen,
  StoreAuditSectionScreen,
  StoreRequestsSectionScreen,
} from '../../screens/storeManager/StoreSectionScreens';
import { HandoverToStoreScreen } from '../../screens/floorManager/HandoverToStoreScreen';
import { OpeningStockScreen } from '../../screens/storeManager/OpeningStockScreen';
import { MachineListScreen } from '../../screens/floorManager/MachineListScreen';
import { MachineWorkforceScreen } from '../../screens/floorManager/MachineWorkforceScreen';
import { AssignMachineModal } from '../../screens/floorManager/AssignMachineModal';
import { OpenShiftScreen } from '../../screens/floorManager/OpenShiftScreen';
import { ShiftCloseQueueScreen } from '../../screens/floorManager/ShiftCloseQueueScreen';
import { ShiftCloseScreen } from '../../screens/floorManager/ShiftCloseScreen';
import { SalaryRunScreen } from '../../screens/accountant/SalaryRunScreen';
import { WorkerLedgerScreen } from '../../screens/accountant/WorkerLedgerScreen';
import { MastersTabsScreen } from '../../screens/owner/MastersTabsScreen';
import { EmployeeManagementScreen } from '../../screens/owner/EmployeeManagementScreen';
import { AddEmployeeScreen } from '../../screens/owner/AddEmployeeScreen';
// ---- Phase 7 ----
import { FinalQaQueueScreen, FinalQaDetailScreen } from '../../screens/floorManager/FinalQaScreen';
import { LedgersHomeScreen } from '../../screens/accountant/LedgersHomeScreen';
import {
  InvoiceDetailScreen,
  RecordPoPaymentScreen,
  AddLoanScreen,
} from '../../screens/accountant/PaymentScreens';
import { ExpensesScreen } from '../../screens/accountant/ExpensesScreen';
import { ApprovalsInboxScreen, ApprovalDetailScreen } from '../../screens/owner/ApprovalsInboxScreen';
import {
  ReportsHubScreen,
  ProfitabilityReportScreen,
  PlReportScreen,
  LeakageReportScreen,
  ProductivityReportScreen,
  UptimeReportScreen,
} from '../../screens/owner/ReportsHubScreen';
import { ExtraPermissionsScreen } from '../../screens/owner/ExtraPermissionsScreen';
// ---- Accountant dashboard: six boxes + invoices ----
import { AccountantDashboardScreen } from '../../screens/accountant/AccountantDashboardScreen';
import {
  AccountantClientsScreen,
  AccountantClientDetailScreen,
} from '../../screens/accountant/ClientsScreen';
import {
  AccountantSuppliersScreen,
  AccountantSupplierDetailScreen,
} from '../../screens/accountant/SuppliersScreen';
import {
  AccountantEmployeesScreen,
  AccountantEmployeeDetailScreen,
} from '../../screens/accountant/AccountantEmployeesScreen';
import {
  AccountantMachinesScreen,
  AccountantMachineDetailScreen,
} from '../../screens/accountant/AccountantMachinesScreen';
import { AccountantInvoicesScreen } from '../../screens/accountant/InvoicesScreen';
import { AccountantAddExpenseScreen } from '../../screens/accountant/AddExpenseScreen';
import { ROLES, ROLE_HOME_TITLE, type Role } from '../../constants/roles';
import { mastersForRole } from './roleMasters';
import { getMasterConfig } from '../../masters/configs';

// ---- Phase 6: Finishing stages & delivery (loaded for delivery, qa, floor_manager) ----
import { DeliveryOrdersScreen } from '../../screens/deliveryPerson/DeliveryOrdersScreen';
import { SlaAlertsScreen } from '../../screens/deliveryPerson/SlaAlertsScreen';
import { FinalDeliveryScreen } from '../../screens/deliveryPerson/FinalDeliveryScreen';
import { FinalPassQueueScreen } from '../../screens/qa/FinalPassQueueScreen';

// ---- Phase 8: Worker & Finishing Partner dashboards ----
import { WorkerDashboardScreen } from '../../screens/worker/DashboardScreen';
import { SalaryBreakdownScreen } from '../../screens/worker/SalaryBreakdownScreen';
import { ReportDowntimeScreen } from '../../screens/worker/ReportDowntimeScreen';
import { LeaveRequestScreen } from '../../screens/worker/LeaveRequestScreen';
import { PartnerDashboardScreen } from '../../screens/finishingPartner/PartnerDashboardScreen';

// ---- Super Admin: factory management & billing ----
import { FactoryListScreen } from '../../screens/superAdmin/FactoryListScreen';
import { FactoryDetailScreen } from '../../screens/superAdmin/FactoryDetailScreen';
import { NewFactoryScreen } from '../../screens/superAdmin/NewFactoryScreen';
import { ModuleToggleScreen } from '../../screens/superAdmin/ModuleToggleScreen';

/** The home screen each role lands on. */
function homeFor(role: Role): React.ComponentType {
  switch (role) {
    case ROLES.ORDER_TAKER:
      // Two boxes and the New Order button. The Phase 3 order list is what the
      // Orders box opens — it was the home screen until now.
      return OrderTakerDashboardScreen;
    case ROLES.QA:
      return QaDashboardScreen;
    case ROLES.FLOOR_MANAGER:
      return FloorManagerDashboardScreen;
    case ROLES.PROCUREMENT:
      return PoQueueScreen;
    case ROLES.STORE_MANAGER:
      // Four tabs and nothing else. Stock Home is still registered for other
      // roles that reach it, but it is no longer this role's landing screen.
      return StoreManagerHomeScreen;
    case ROLES.ACCOUNTANT:
      // Six boxes and nothing else. The Phase 7 Ledgers Home is still reachable
      // from the Invoices box for loans and payment history.
      return AccountantDashboardScreen;
    case ROLES.DELIVERY:
      // One tab: Orders. The old Handoff/Return/SLA split is gone — every leg
      // of this role's work is an entry in this single list now.
      return DeliveryOrdersScreen;
    case ROLES.WORKER:
      return WorkerDashboardScreen;
    case ROLES.FINISHING_PARTNER:
      return PartnerDashboardScreen;
    case ROLES.SUPER_ADMIN:
      return FactoryListScreen;
    case ROLES.COMPANY_ADMIN:
      return MastersTabsScreen;
    default:
      // Company Admin is handled above. Other late-phase roles still use the
      // generic role home shell until their business screens arrive.
      return RoleHomeScreen;
  }
}

export function createRoleNavigator(role: Role) {
  const Stack = createNativeStackNavigator();
  const hasMasters = mastersForRole(role).length > 0;

  // Order-spine screens: which roles can reach which.
  const canOrders = role === ROLES.ORDER_TAKER;
  const canQA = role === ROLES.QA;
  const canJobCard = role === ROLES.FLOOR_MANAGER;
  // Everyone touching the spine needs the read-only order detail.
  const canOrderDetail = canOrders || canQA || canJobCard;

  // Phase 4. The procurement, stock, and accounting nav remains role-specific.
  const canProcurement = role === ROLES.PROCUREMENT;
  const canStock = role === ROLES.STORE_MANAGER;
  const canViewPos = canProcurement || role === ROLES.ACCOUNTANT;

  // Phase 5: shift close + payroll (module-gated inside each screen).
  const canShift = role === ROLES.FLOOR_MANAGER;
  const canPayroll = role === ROLES.ACCOUNTANT;
  // ---- Phase 7 ----
  const canFinance = role === ROLES.ACCOUNTANT;
  // Was `false`, which left ApprovalsInbox/ApprovalDetail unregistered — so the
  // owner's "approvals waiting on you" banner had no destination to open.
  const canApprove = role === ROLES.COMPANY_ADMIN;
  const canReports = false;
  const canFinalQa = role === ROLES.FLOOR_MANAGER;

  function RoleNavigator() {
    return (
      <Stack.Navigator
        screenOptions={{
          header: ({ navigation, options, back }) => (
            <AppHeader title={options.title} canGoBack={!!back} onBack={navigation.goBack} navigation={navigation} />
          ),
        }}
      >
        {/* The home screen gets the greeting form of the header (avatar, "Hi,
            [Name]", factory name, bell). Every other screen keeps the
            back-arrow + title + role-badge form from `screenOptions` above —
            same palette, same bell, unchanged navigation. */}
        <Stack.Screen
          name="RoleHome"
          component={homeFor(role)}
          options={{
            title: ROLE_HOME_TITLE[role],
            // The home screen renders DashboardHeader ITSELF rather than having
            // the navigator supply it. The header carries the search bar, and
            // the search state belongs to the screen doing the filtering — from
            // out here there was nothing to wire it to, so every dashboard
            // rendered the header with no `onSearchChange` and the bar silently
            // disappeared. That was the missing-search-bar bug.
            headerShown: false,
          }}
        />

        {/* The filtered list behind a task banner. Registered for every role
            because every role has banners; which queues it can actually load is
            enforced in `my_queue_items`, not by hiding the route. */}
        <Stack.Screen
          name="TaskQueue"
          component={TaskQueueScreen}
          options={{ title: 'Waiting on you' }}
        />

        {hasMasters ? (
          <>
            <Stack.Screen
              name="MasterList"
              component={MasterListScreen}
              options={({ route }: any) => ({
                title: route.params?.entity
                  ? getMasterConfig(route.params.entity).plural
                  : 'Master data',
              })}
            />
            <Stack.Screen
              name="MasterForm"
              component={MasterFormScreen}
              options={({ route }: any) => ({
                title: route.params?.entity
                  ? getMasterConfig(route.params.entity).singular
                  : 'Record',
              })}
            />
          </>
        ) : null}

        {/* The order taker's home is now the two-box dashboard, so the list is a
            route for them too — it is what the Orders box opens. */}
        {canOrders ? (
          <>
            <Stack.Screen name="MyOrders" component={MyOrdersScreen} options={{ title: 'Orders' }} />
            <Stack.Screen name="NewOrder" component={NewOrderScreen} options={{ title: 'New order' }} />
          </>
        ) : null}

        {/* Returns: read-only stage tracking for the orders this user captured. */}
        {role === ROLES.ORDER_TAKER ? (
          <Stack.Screen name="Returns" component={ReturnsScreen} options={{ title: 'Returns' }} />
        ) : null}

        {canOrderDetail ? (
          <Stack.Screen name="OrderDetail" component={OrderDetailScreen} options={{ title: 'Order' }} />
        ) : null}

        {canQA ? (
          <>
            <Stack.Screen
              name="InspectionQueue"
              component={InspectionQueueScreen}
              options={{ title: 'Awaiting order inspection' }}
            />
            <Stack.Screen
              name="ClothInspection"
              component={ClothInspectionScreen}
              options={{ title: 'Cloth inspection' }}
            />
            <Stack.Screen
              name="OrderQa"
              component={OrderQaScreen}
              options={{ title: 'Order QA' }}
            />
            <Stack.Screen
              name="StageTrackingQueue"
              component={StageTrackingQueueScreen}
              options={{ title: 'Repeats & stage tracking' }}
            />
            <Stack.Screen
              name="FinalPassQueue"
              component={FinalPassQueueScreen}
              options={{ title: 'Final pass' }}
            />
            <Stack.Screen
              name="StageTracking"
              component={StageTrackingScreen}
              options={{ title: 'Stage tracking' }}
            />
          </>
        ) : null}

        {canJobCard ? (
          <>
            <Stack.Screen name="OrdersBox" component={OrdersBoxScreen} options={{ title: 'Orders' }} />
            <Stack.Screen name="MachineBox" component={MachineBoxScreen} options={{ title: 'Machine' }} />
            <Stack.Screen name="LeaveBox" component={LeaveBoxScreen} options={{ title: 'Leave' }} />
            <Stack.Screen name="DamagesBox" component={DamagesBoxScreen} options={{ title: 'Damages' }} />
            <Stack.Screen
              name="JobCardBuilder"
              component={JobCardBuilderScreen}
              options={{ title: 'Job card builder' }}
            />
            <Stack.Screen
              name="JobCardReview"
              component={JobCardReviewScreen}
              options={{ title: 'Review job card' }}
            />
            <Stack.Screen name="JobCard" component={JobCardScreen} options={{ title: 'Job card' }} />
            <Stack.Screen
              name="StageTracking"
              component={StageTrackingScreen}
              options={{ title: 'Stage tracking' }}
            />
          </>
        ) : null}

        {/* ---- Phase 4: procurement ---- */}
        {canViewPos ? (
          <>
            {role !== ROLES.PROCUREMENT ? (
              <Stack.Screen
                name="PoQueue"
                component={PoQueueScreen}
                options={{ title: 'Purchase orders' }}
              />
            ) : null}
            <Stack.Screen
              name="PoDetail"
              component={PoDetailScreen}
              options={{ title: 'Purchase order' }}
            />
          </>
        ) : null}

        {canProcurement ? (
          <Stack.Screen name="NewPo" component={NewPoScreen} options={{ title: 'New PO' }} />
        ) : null}

        {/* ---- Phase 4: store manager ---- */}
        {canStock ? (
          <>
            {role !== ROLES.STORE_MANAGER ? (
              <Stack.Screen
                name="StockHome"
                component={StockHomeScreen}
                options={{ title: 'Thread stock' }}
              />
            ) : null}
            <Stack.Screen
              name="StockLedger"
              component={StockLedgerScreen}
              options={{ title: 'Stock history' }}
            />
            <Stack.Screen name="GrnQueue" component={GrnQueueScreen} options={{ title: 'GRN queue' }} />
            <Stack.Screen name="GrnDetail" component={GrnDetailScreen} options={{ title: 'Goods received' }} />
            <Stack.Screen
              name="MaterialIssueQueue"
              component={MaterialIssueQueueScreen}
              options={{ title: 'Material issue' }}
            />
            <Stack.Screen name="IssueDetail" component={IssueDetailScreen} options={{ title: 'Issue materials' }} />
            {/* The weekly audit screen stays registered but is no longer linked
                from anywhere: the Store Manager's Audit tab is daily now. It is
                left in place so a factory mid-way through the old flow can still
                reach a bookmarked route rather than hitting a dead link. */}
            <Stack.Screen name="StockAudit" component={StockAuditScreen} options={{ title: 'Stock audit' }} />
            <Stack.Screen name="OpeningStock" component={OpeningStockScreen} options={{ title: 'Opening stock' }} />

            {/* ---- The four tabs' own screens ---- */}
            <Stack.Screen
              name="AddInventory"
              component={AddInventoryScreen}
              options={{ title: 'Add stock' }}
            />
            <Stack.Screen
              name="StoreNewPo"
              component={StoreNewPoScreen}
              options={{ title: 'New purchase order' }}
            />
            <Stack.Screen
              name="DailyAudit"
              component={DailyAuditScreen}
              options={{ title: 'Today’s audit' }}
            />
            <Stack.Screen
              name="AuditDetail"
              component={AuditDetailScreen}
              options={({ route }: any) => ({ title: route.params?.code ?? 'Audit' })}
            />
            {/* The PO tab opens procurement's existing PO screen rather than a
                store-manager copy of it. Registered here because that screen
                previously belonged to procurement and the accountant only. */}
            {/* The four sections behind the dashboard's 2x2 grid. Each holds its
                own record list as single-column rows — the grid is top level
                only, matching the Floor Manager's Orders/Machine/Shift/Leave
                boxes exactly. */}
            <Stack.Screen name="StorePoSection" component={StorePoSectionScreen} options={{ title: 'PO' }} />
            <Stack.Screen
              name="StoreInventorySection"
              component={StoreInventorySectionScreen}
              options={{ title: 'Inventory' }}
            />
            <Stack.Screen
              name="StoreAuditSection"
              component={StoreAuditSectionScreen}
              options={{ title: 'Audit' }}
            />
            <Stack.Screen
              name="StoreRequestsSection"
              component={StoreRequestsSectionScreen}
              options={{ title: 'Requests' }}
            />
            <Stack.Screen name="PoDetail" component={PoDetailScreen} options={{ title: 'Purchase order' }} />
          </>
        ) : null}

        {/* ---- Phase 5: machine assignment + shift close ---- */}
        {canShift ? (
          <>
            <Stack.Screen
              name="MachineList"
              component={MachineListScreen}
              options={{ title: 'Machine assignment' }}
            />
            <Stack.Screen
              name="MachineWorkforce"
              component={MachineWorkforceScreen}
              options={{ title: 'Machine & Workforce' }}
            />
            <Stack.Screen
              name="AssignMachine"
              component={AssignMachineModal}
              options={{ title: 'Assign machine', presentation: 'modal' }}
            />
            <Stack.Screen name="OpenShift" component={OpenShiftScreen} options={{ title: 'Open shift' }} />
            <Stack.Screen
              name="ShiftCloseQueue"
              component={ShiftCloseQueueScreen}
              options={{ title: 'Shift close walk' }}
            />
            <Stack.Screen name="ShiftClose" component={ShiftCloseScreen} options={{ title: 'Close shift' }} />
          </>
        ) : null}

        {/* ---- Phase 5: payroll ---- */}
        {canPayroll ? (
          <>
            <Stack.Screen
              name="SalaryRun"
              component={SalaryRunScreen}
              options={{ title: 'Salary run' }}
            />
            <Stack.Screen
              name="WorkerLedger"
              component={WorkerLedgerScreen}
              options={({ route }: any) => ({
                title: route.params?.workerName ?? 'Worker ledger',
              })}
            />
          </>
        ) : null}

        {role === ROLES.COMPANY_ADMIN ? (
          <>
            <Stack.Screen name="MastersTabs" component={MastersTabsScreen} options={{ title: 'Masters' }} />
            <Stack.Screen name="EmployeeManagement" component={EmployeeManagementScreen} options={{ title: 'Employees' }} />
            <Stack.Screen name="AddEmployee" component={AddEmployeeScreen} options={{ title: 'Add employee' }} />
          </>
        ) : null}

        {/* ---- Phase 6: Finishing stages & delivery ---- */}
        {/* Delivery Person: handoff/return/sla/detail screens.
            HandoffQueue is registered explicitly (even for delivery who has it as home)
            so that tab-bar navigation from ReturnQueue/etc. resolves the route name. */}
        {/* Delivery Person has exactly ONE tab (Orders, the home screen above).
            FinalDelivery stays registered because the final client handover is
            reached from an entry INSIDE that list, not from a tab of its own —
            dropping the route would orphan the only way to complete a delivery.
            HandoffQueue / ReturnQueue / SlaAlerts are deliberately not
            registered any more: their work is now rows in the Orders list. */}
        {role === ROLES.DELIVERY ? (
          <>
            <Stack.Screen name="FinalDelivery" component={FinalDeliveryScreen} options={{ title: 'Complete delivery' }} />
          </>
        ) : null}

        {/* QA and Floor Manager get SLA alerts and collection QA */}
        {(role === ROLES.QA || role === ROLES.FLOOR_MANAGER) ? (
          <>
            <Stack.Screen name="SlaAlerts" component={SlaAlertsScreen} options={{ title: 'SLA alerts' }} />
          </>
        ) : null}

        {/* Collection QA is GONE (0063). It belonged to Phase 6's handoff
            pipeline, which ran in parallel with 0056's stage loop and stranded
            every repeat it did not itself touch. One pipeline now. */}

        {/* ---- Phase 7: final QA + invoicing ---- */}
        {canFinalQa ? (
          <>
            <Stack.Screen name="FinalQaQueue" component={FinalQaQueueScreen} options={{ title: 'Final QA' }} />
            <Stack.Screen name="FinalQaDetail" component={FinalQaDetailScreen} options={{ title: 'Final QA' }} />
            {/* Handing leftover material back to the store, once an order is done. */}
            <Stack.Screen
              name="HandoverToStore"
              component={HandoverToStoreScreen}
              options={{ title: 'Handover to store' }}
            />
          </>
        ) : null}

        {/* ---- Phase 7: ledgers ---- */}
        {canFinance ? (
          <>
            <Stack.Screen name="LedgersHome" component={LedgersHomeScreen} options={{ title: 'Ledgers' }} />
            <Stack.Screen name="InvoiceDetail" component={InvoiceDetailScreen} options={{ title: 'Invoice' }} />
            <Stack.Screen name="RecordPoPayment" component={RecordPoPaymentScreen} options={{ title: 'Record payment' }} />
            <Stack.Screen name="AddLoan" component={AddLoanScreen} options={{ title: 'Record loan' }} />
            <Stack.Screen name="Expenses" component={ExpensesScreen} options={{ title: 'Expenses' }} />
          </>
        ) : null}

        {/* ---- Accountant dashboard: the six boxes ----
            Finishing Partner is deliberately absent: that card opens MasterList
            /MasterForm, the same screens the Company Admin uses, which are
            already registered above for every role with masters. */}
        {role === ROLES.ACCOUNTANT ? (
          <>
            <Stack.Screen name="AcctClients" component={AccountantClientsScreen} options={{ title: 'Clients' }} />
            <Stack.Screen
              name="AcctClientDetail"
              component={AccountantClientDetailScreen}
              options={({ route }: any) => ({ title: route.params?.name ?? 'Client' })}
            />
            <Stack.Screen name="AcctSuppliers" component={AccountantSuppliersScreen} options={{ title: 'Suppliers' }} />
            <Stack.Screen
              name="AcctSupplierDetail"
              component={AccountantSupplierDetailScreen}
              options={({ route }: any) => ({ title: route.params?.name ?? 'Supplier' })}
            />
            <Stack.Screen name="AcctEmployees" component={AccountantEmployeesScreen} options={{ title: 'Employees' }} />
            <Stack.Screen
              name="AcctEmployeeDetail"
              component={AccountantEmployeeDetailScreen}
              options={({ route }: any) => ({ title: route.params?.name ?? 'Employee' })}
            />
            <Stack.Screen name="AcctMachines" component={AccountantMachinesScreen} options={{ title: 'Machines' }} />
            <Stack.Screen
              name="AcctMachineDetail"
              component={AccountantMachineDetailScreen}
              options={({ route }: any) => ({ title: route.params?.name ?? 'Machine' })}
            />
            <Stack.Screen name="AcctInvoices" component={AccountantInvoicesScreen} options={{ title: 'Invoices' }} />
            <Stack.Screen
              name="AcctAddExpense"
              component={AccountantAddExpenseScreen}
              options={({ route }: any) => ({
                title: route.params?.category === 'maintenance' ? 'Add expense' : 'Add bill',
              })}
            />
          </>
        ) : null}

        {/* ---- Phase 7: owner approvals ---- */}
        {canApprove ? (
          <>
            <Stack.Screen name="ApprovalsInbox" component={ApprovalsInboxScreen} options={{ title: 'Approvals' }} />
            <Stack.Screen name="ApprovalDetail" component={ApprovalDetailScreen} options={{ title: 'Review' }} />
            <Stack.Screen name="ExtraPermissions" component={ExtraPermissionsScreen} options={{ title: 'Extra permissions' }} />
          </>
        ) : null}

        {/* ---- Phase 7: reports ---- */}
        {canReports ? (
          <>
            <Stack.Screen name="ReportsHub" component={ReportsHubScreen} options={{ title: 'Reports' }} />
            <Stack.Screen name="ReportProfitability" component={ProfitabilityReportScreen} options={{ title: 'Per-order profitability' }} />
            <Stack.Screen name="ReportPl" component={PlReportScreen} options={{ title: 'Company P&L' }} />
            <Stack.Screen name="ReportLeakage" component={LeakageReportScreen} options={{ title: 'Inventory leakage' }} />
            <Stack.Screen name="ReportProductivity" component={ProductivityReportScreen} options={{ title: 'Worker productivity' }} />
            <Stack.Screen name="ReportUptime" component={UptimeReportScreen} options={{ title: 'Machine uptime' }} />
          </>
        ) : null}

        {/* ---- Phase 8: worker dashboards ---- */}
        {role === ROLES.WORKER ? (
          <>
            <Stack.Screen
              name="SalaryBreakdown"
              component={SalaryBreakdownScreen}
              options={{ title: 'Salary breakdown' }}
            />
            <Stack.Screen
              name="ReportDowntime"
              component={ReportDowntimeScreen}
              options={{ title: 'Report downtime' }}
            />
            <Stack.Screen
              name="LeaveRequest"
              component={LeaveRequestScreen}
              options={{ title: 'Leave request' }}
            />
          </>
        ) : null}

        {/* ---- Super Admin: factory management ---- */}
        {role === ROLES.SUPER_ADMIN ? (
          <>
            <Stack.Screen
              name="FactoryDetail"
              component={FactoryDetailScreen}
              options={{ title: 'Factory' }}
            />
            <Stack.Screen
              name="NewFactory"
              component={NewFactoryScreen}
              options={{ title: 'Add factory' }}
            />
            <Stack.Screen
              name="ModuleToggle"
              component={ModuleToggleScreen}
              options={{ title: 'Module toggle' }}
            />
          </>
        ) : null}
      </Stack.Navigator>
    );
  }

  RoleNavigator.displayName = `${role}Navigator`;
  return RoleNavigator;
}
