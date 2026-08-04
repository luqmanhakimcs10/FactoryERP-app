/**
 * Employees API — the Owner's staff management (0030).
 *
 * Listing reads profiles + employee_compensation directly (RLS scopes both to
 * the caller's factory and the finance/owner roles). Creating and deactivating
 * go through SECURITY DEFINER RPCs: profiles writes are super-admin-only by RLS,
 * so creating a login is exactly what an elevated function is for.
 */
import { supabase } from '../client';
import type { EmployeeRow, SalaryType } from '../../models/types';

export async function listEmployees(): Promise<EmployeeRow[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, role, is_active, created_at, employee_compensation(*)')
    .order('display_name');
  if (error) throw error;
  return (data ?? []) as unknown as EmployeeRow[];
}

export interface CreateEmployeeParams {
  email: string;
  password: string;
  displayName: string;
  role: string;
  salaryType: SalaryType;
  salaryAmount: number;
}

export async function createEmployee(params: CreateEmployeeParams): Promise<{ id: string; email: string }> {
  const { data, error } = await supabase.rpc('create_employee', {
    p_email: params.email,
    p_password: params.password,
    p_display_name: params.displayName,
    p_role: params.role,
    p_salary_type: params.salaryType,
    p_salary_amount: params.salaryAmount,
  });
  if (error) throw error;
  return data as { id: string; email: string };
}

export async function countEmployees(): Promise<number> {
  const { count, error } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true });
  if (error) throw error;
  return count ?? 0;
}

export async function deactivateEmployee(userId: string): Promise<void> {
  const { error } = await supabase.rpc('deactivate_employee', { p_user_id: userId });
  if (error) throw error;
}
