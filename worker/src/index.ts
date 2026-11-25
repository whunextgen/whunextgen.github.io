// API 层：飞书登录、会话、只读视图、业务函数。
// 所有校验都在数据库函数里；这里只负责认出是谁，并把身份带进事务。
import postgres from 'postgres';
import { MARK_PNG, MARK_WHITE_PNG } from './mark.ts';

export interface Env {
  ZOOM_ACCOUNT_ID?: string; ZOOM_CLIENT_ID?: string; ZOOM_CLIENT_SECRET?: string;   // Zoom 服务端应用：读参会报告和云录制
  ANTHROPIC_API_KEY?: string;   // 录音补漏：从逐字稿里自动找出质疑。没有设的，由济民按需提取
  HYPERDRIVE: { connectionString: string };   // 以 app_api 角色连接 Supabase Postgres
  FEISHU_APP_ID: string;
  FEISHU_APP_SECRET: string;
  // 发通知用的应用（机器人）。不设时沿用登录应用
  NOTICE_ORIGIN?: string;                     // 通知卡片里按钮跳转的中台地址；不设时用对成员公布的地址
  CARD_ACTIONS?: string;                      // 设为 1 时，能在卡片上办的通知带「同意」按钮；飞书后台配好回调地址之后再开
  FEISHU_VERIFICATION_TOKEN?: string;         // 飞书回调的校验令牌；设了就核对，不设时只凭卡片上的办理凭据
  NOTICE_CHAT_ID?: string;                    // 全员群。队列里对象为 group 的通知发到这个群；不设时这类通知发不出去，记为失败
  FEISHU_BOT_APP_ID?: string;
  FEISHU_BOT_APP_SECRET?: string;
  FEISHU_TENANT_KEY?: string;                 // 设了就只允许本租户
  SESSION_SECRET: string;
  APP_ORIGIN?: string;                        // 前端地址；不设时前端与接口同源（页面由本 Worker 的静态资源提供）
  VAULT_KEY?: string;                         // 加密密钥与账号用的口令；丢了，库里存的密钥就解不开
  FEISHU_NOTIFY?: string;                     // 设为 on 才真正发飞书通知；不设时消息只在数据库里排队，过 24 小时作废
  ASSIST_CHAT_ID?: string;                    // 协助群。队列里对象为 assist 的通知（GitHub 事件）发到这个群
  GITHUB_WEBHOOK_SECRET?: string;             // GitHub webhook 的签名密钥；不设时不收 GitHub 事件
}

export const VIEWS = new Set(['name_option', 'name_poll', 'me', 'users', 'card_pick', 'fund_project', 'card_school_subject', 'card_subject_map', 'card_income', 'subject', 'expense_type', 'card', 'cell', 'node', 'cap', 'rule', 'ruling',
  'request', 'request_event', 'procurement_event', 'budget_change', 'fund_event', 'person', 'pay_type', 'staff',
  'payroll_sheet', 'settlement', 'emergency', 'year_actual', 'settle_check',
  'template', 'template_cap', 'user_admin', 'outbox', 'project_tag', 'resource', 'allocation',
  'legacy_ms_submission', 'legacy_ms_item', 'legacy_budget_adjust', 'legacy_resource_request', 'legacy_quota_ledger', 'legacy_source', 'legacy_record', 'legacy_recon',
  'project', 'budget_category', 'budget_year', 'project_budget', 'budget_line',
  'budget_plan', 'budget_source', 'budget_module', 'budget_tier', 'tier_pick', 'module_topic', 'unit_apply', 'unit_exec',
  'token_param', 'tier_token', 'token_me', 'time_log', 'unit_pool', 'unit_share', 'outcome',
  'biweekly_report', 'biweekly_status', 'submission', 'submission_review', 'review_point', 'review_thread', 'review_summary',
  'arr_cycle', 'arr_sponsor', 'arr_claim', 'path_tracker', 'path_person', 'rank_change',
  'seminar', 'snapshot', 'snapshot_pitch', 'query', 'person_attr', 'daily_mine', 'attend_event', 'assessment', 'merit', 'path_alert',
  'today_mine', 'review_note', 'praise_mine', 'challenge_mine', 'title_mine', 'coin_mine', 'coin_ledger', 'compute_grant', 'period_record', 'unit_coin', 'unit_coin_balance', 'cluster_quota', 'cluster_usage', 'course', 'unit_status', 'meeting', 'leave_mine', 'meeting_sync', 'center_calendar', 'query_draft', 'speak_order', 'meeting_transcript',
  'category_subject', 'budget_alloc', 'line_exec', 'line_pick', 'budget_revision', 'budget_review',
  'resource_pick', 'resource_plan', 'resource_request', 'resource_stock', 'secret_access', 'petty_cash',
  'perm', 'role', 'role_grant', 'rbac_log',
  'api_token', 'api_call',
  'project_member', 'people_pick', 'project_cap', 'cap_request', 'budget_shift', 'project_asset', 'project_allocation', 'year_check', 'rule_lookup', 'task', 'task_step']);

// 函数名 → 参数名与类型（按位置传给数据库函数）
export const RPC: Record<string, [string, string][]> = {
  // 投稿与评审的自行填报
  submission_save: [['id', 'uuid'], ['project_id', 'uuid'], ['relation', 'text'], ['venue', 'text'], ['cycle', 'text'], ['number', 'int'], ['title', 'text'], ['status', 'text'], ['link', 'text'], ['scale', 'numeric'], ['keep', 'text'], ['ac_overall', 'numeric'], ['ac_text', 'text']],
  submission_delete: [['id', 'uuid']],
  review_save: [['id', 'uuid'], ['submission_id', 'uuid'], ['reviewer', 'text'], ['overall', 'numeric'], ['soundness', 'numeric'], ['excitement', 'numeric'], ['confidence', 'numeric'], ['strengths', 'text'], ['weaknesses', 'text'], ['comments', 'text']],
  review_delete: [['id', 'uuid']],
  submit_request: [['card_id', 'uuid'], ['subject_id', 'uuid'], ['expense_type_id', 'uuid'], ['title', 'text'], ['amount', 'numeric'], ['eta_date', 'date'], ['emergency', 'boolean'], ['path', 'text']],
  approve_request: [['id', 'uuid']],
  reject_request: [['id', 'uuid'], ['note', 'text']],
  send_to_school: [['id', 'uuid']],
  post_voucher: [['id', 'uuid'], ['posted_on', 'date'], ['amount', 'numeric'], ['voucher_no', 'text']],
  school_return: [['id', 'uuid'], ['reason', 'text']],
  move_request: [['id', 'uuid'], ['card_id', 'uuid'], ['subject_id', 'uuid']],
  release_request: [['id', 'uuid']],
  procurement_advance: [['id', 'uuid']],
  procurement_fail: [['id', 'uuid'], ['kind', 'text'], ['reason', 'text'], ['delay_days', 'int']],
  create_change: [['card_id', 'uuid'], ['reason', 'text'], ['lines', 'jsonb']],
  confirm_change: [['id', 'uuid']],
  reject_change: [['id', 'uuid']],
  approve_change: [['id', 'uuid'], ['approved_on', 'date']],
  reassign_staff: [['person_id', 'uuid'], ['pay_type_id', 'uuid'], ['from_month', 'date'], ['to_month', 'date'], ['card_id', 'uuid']],
  build_payroll: [['month', 'date']],
  post_payroll: [['id', 'uuid'], ['posted_on', 'date']],
  settle_card: [['card_id', 'uuid']],
  reopen_card: [['card_id', 'uuid'], ['note', 'text']],
  add_ruling: [['card_id', 'uuid'], ['expense_type_id', 'uuid'], ['ruled_on', 'date'], ['ruled_by', 'text'], ['verdict', 'text'], ['note', 'text'], ['source', 'text']],
  finish_fund_event: [['id', 'uuid']],
  add_fund_event: [['card_id', 'uuid'], ['kind', 'text'], ['event_date', 'date'], ['amount', 'numeric'], ['todo', 'text']],
  save_expense_type: [['id', 'uuid'], ['name', 'text'], ['required_path', 'text']],
  save_person: [['id', 'uuid'], ['name', 'text']],
  save_pay_type: [['id', 'uuid'], ['name', 'text'], ['subject_code', 'text'], ['monthly_cap', 'numeric']],
  set_staff: [['person_id', 'uuid'], ['pay_type_id', 'uuid'], ['from_month', 'date'], ['to_month', 'date'], ['card_id', 'uuid'], ['amount', 'numeric']],
  set_user_role: [['user_id', 'uuid'], ['role', 'text'], ['active', 'boolean']],
  set_user_kind: [['user_id', 'uuid'], ['kind', 'text']],
  save_role: [['id', 'uuid'], ['name', 'text'], ['note', 'text'], ['perms', 'jsonb']],
  delete_role: [['id', 'uuid']],
  grant_role: [['user_id', 'uuid'], ['role_id', 'uuid'], ['project_id', 'uuid'], ['card_id', 'uuid'], ['from_date', 'date'], ['to_date', 'date'], ['note', 'text']],
  revoke_grant: [['id', 'uuid'], ['note', 'text']],
  save_template: [['id', 'uuid'], ['code', 'text'], ['name', 'text'], ['locked', 'boolean']],
  save_subject: [['id', 'uuid'], ['template_id', 'uuid'], ['code', 'text'], ['name', 'text'], ['school_name', 'text'], ['sort', 'int']],
  delete_subject: [['id', 'uuid']],
  save_cap: [['id', 'uuid'], ['template_id', 'uuid'], ['name', 'text'], ['max_ratio', 'numeric'], ['subject_ids', 'jsonb']],
  delete_cap: [['id', 'uuid']],
  save_card: [['id', 'uuid'], ['card_no', 'text'], ['name', 'text'], ['template_id', 'uuid'], ['owner_id', 'uuid'], ['start_date', 'date'],
    ['cutoff_date', 'date'], ['settle_date', 'date'], ['end_rule', 'text'], ['rule_note', 'text']],
  set_node: [['card_id', 'uuid'], ['node_date', 'date'], ['ratio', 'numeric'], ['consequence', 'text']],
  delete_node: [['id', 'uuid']],
  set_budget: [['card_id', 'uuid'], ['lines', 'jsonb']],
  save_card_subject: [['id', 'uuid'], ['card_id', 'uuid'], ['name', 'text']],
  delete_card_subject: [['id', 'uuid']],
  map_school_subject: [['card_id', 'uuid'], ['ledger', 'uuid'], ['subject', 'uuid']],
  set_emergency_limit: [['year', 'int'], ['per_request', 'numeric'], ['per_year', 'numeric']],
  save_user: [['id', 'uuid'], ['name', 'text'], ['email', 'text'], ['role', 'text'], ['active', 'boolean']],
  merge_user: [['from_id', 'uuid'], ['into_id', 'uuid']],
  set_school_balance: [['card_id', 'uuid'], ['balance', 'numeric'], ['frozen', 'numeric'], ['available', 'numeric']],
  post_vouchers: [['rows', 'jsonb']],
  save_budget_source: [['year', 'int'], ['fund_project', 'uuid'], ['amount', 'numeric'], ['note', 'text']],
  save_budget_module: [['id', 'uuid'], ['year', 'int'], ['project', 'uuid'], ['amount', 'numeric'], ['note', 'text']],
  save_budget_tier: [['id', 'uuid'], ['year', 'int'], ['name', 'text'], ['amount', 'numeric'], ['slots', 'int'], ['labor_ratio', 'numeric'], ['limits', 'jsonb']],
  publish_budget_plan: [['year', 'int'], ['on', 'boolean']],
  pick_tier: [['year', 'int'], ['project', 'uuid'], ['tier', 'uuid'], ['reason', 'text']],
  decide_tier: [['year', 'int'], ['project', 'uuid'], ['tier', 'uuid'], ['note', 'text'], ['on', 'date']],
  propose_project: [['year', 'int'], ['name', 'text'], ['tier', 'uuid'], ['reason', 'text'], ['units', 'text']],
  withdraw_proposal: [['year', 'int'], ['project', 'uuid']],
  propose_unit: [['id', 'uuid'], ['parent', 'uuid'], ['name', 'text'], ['meeting_on', 'date'], ['minutes_on', 'date'], ['note', 'text'], ['members', 'text']],
  propose_name: [['name', 'text'], ['note', 'text']],
  vote_name: [['option', 'uuid']],
  set_scholar_url: [['url', 'text']],
  save_person_record: [['id', 'uuid'], ['no', 'text'], ['name', 'text'], ['kind', 'text'], ['status', 'text'], ['joined', 'date'], ['left', 'date'],
    ['edu', 'text'], ['school', 'text'], ['direction', 'text'], ['mentor', 'text'], ['note', 'text']],
  link_person: [['person', 'uuid'], ['user', 'uuid']],
  open_arr_cycle: [['name', 'text']],
  save_arr_sponsor: [['user', 'uuid'], ['qualified', 'boolean'], ['quota', 'int'], ['note', 'text'], ['offline', 'int']],
  ask_arr: [['project', 'uuid'], ['sponsor', 'uuid']],
  answer_arr: [['id', 'uuid'], ['ok', 'boolean'], ['note', 'text']],
  withdraw_arr: [['id', 'uuid']],
  set_rank: [['person', 'uuid'], ['rank', 'text'], ['basis', 'text']],
  confirm_path_task: [['person', 'uuid'], ['code', 'text'], ['done_on', 'date'], ['note', 'text']],
  undo_path_task: [['person', 'uuid'], ['code', 'text']],
  set_seminar_organizer: [['seminar', 'text'], ['user', 'uuid']],
  save_snapshot: [['project', 'uuid'], ['link', 'text'], ['note', 'text'], ['authors', 'uuid[]']],
  pitch_snapshot: [['snapshot', 'uuid'], ['seminars', 'text[]']],
  decide_pitch: [['pitch', 'uuid'], ['accept', 'boolean'], ['note', 'text'], ['format', 'text']],
  set_seminar_organizers: [['seminar', 'text'], ['users', 'uuid[]']],
  set_seminar_minutes: [['seminar', 'text'], ['oral', 'int'], ['poster', 'int']],
  set_seminar_targets: [['seminar', 'text'], ['oral', 'int'], ['poster', 'int']],
  submit_query_draft: [['pitch', 'uuid'], ['axis', 'text'], ['body', 'text'], ['parent', 'uuid']],
  accept_query_draft: [['id', 'uuid'], ['accept', 'boolean'], ['raised_by', 'uuid']],
  set_card_round: [['pitch', 'uuid'], ['open', 'boolean']],
  record_turn: [['pitch', 'uuid'], ['user', 'uuid'], ['result', 'text']],
  add_query: [['pitch', 'uuid'], ['axis', 'text'], ['body', 'text'], ['raised_by', 'uuid'], ['parent', 'uuid']],
  remove_query: [['query', 'uuid']],
  add_query_member: [['query', 'uuid'], ['user', 'uuid']],
  remove_query_member: [['query', 'uuid'], ['user', 'uuid']],
  ask_join_query: [['query', 'uuid'], ['note', 'text']],
  close_pitch: [['pitch', 'uuid']],
  record_attendance: [['kind', 'text'], ['seminar', 'text'], ['on', 'date'], ['title', 'text'], ['present', 'uuid[]'], ['leave', 'uuid[]'], ['absent', 'uuid[]']],
  mark_made_up: [['event', 'uuid'], ['user', 'uuid']],
  apply_assessment: [['kind', 'text'], ['link', 'text'], ['note', 'text']],
  withdraw_assessment: [['id', 'uuid']],
  join_examiner: [['id', 'uuid'], ['no_conflict', 'boolean']],
  set_small_task: [['id', 'uuid'], ['title', 'text'], ['detail', 'text']],
  judge_small_task: [['id', 'uuid'], ['pass', 'boolean'], ['note', 'text']],
  record_council_vote: [['id', 'uuid'], ['pass', 'boolean'], ['on', 'date'], ['note', 'text']],
  decide_assessment: [['id', 'uuid'], ['pass', 'boolean'], ['note', 'text'], ['mentor', 'uuid']],
  add_merit: [['user', 'uuid'], ['virtue', 'text'], ['what', 'text'], ['on', 'date']],
  log_revision: [['project', 'uuid'], ['query', 'uuid'], ['note', 'text']],
  submit_review: [['snapshot', 'uuid'], ['body', 'text']],
  adopt_review: [['id', 'uuid']],
  give_praise: [['to', 'uuid'], ['virtue', 'text'], ['note', 'text']],
  invest_coins: [['project', 'uuid'], ['amount', 'numeric'], ['note', 'text']],
  open_meeting: [['kind', 'text'], ['seminar', 'text'], ['title', 'text']],
  check_in: [['code', 'text']],
  ask_leave: [['kind', 'text'], ['on', 'date'], ['seminar', 'text'], ['note', 'text']],
  report_makeup: [['event', 'uuid']],
  set_minutes: [['event', 'uuid'], ['link', 'text']],
  end_meeting: [['event', 'uuid']],
  set_feishu_meeting: [['event', 'uuid'], ['link', 'text']],
  set_zoom_meeting: [['event', 'uuid'], ['link', 'text']],
  claim_name: [['event', 'uuid'], ['name', 'text'], ['user', 'uuid']],
  set_center_calendar: [['id', 'text']],
  record_training: [['course', 'text'], ['on', 'date'], ['present', 'uuid[]'], ['leave', 'uuid[]']],
  save_personal_snapshot: [['topic', 'uuid'], ['title', 'text'], ['link', 'text'], ['note', 'text']],
  report_cluster_usage: [['project', 'uuid'], ['period', 'date'], ['hours', 'numeric']],
  ack_cluster_quota: [['project', 'uuid'], ['hours', 'numeric'], ['ok', 'boolean'], ['note', 'text']],
  buy_compute: [['project', 'uuid'], ['hours', 'numeric']],
  rename_project: [['id', 'uuid'], ['name', 'text']],
  approve_unit: [['unit', 'uuid']],
  confirm_unit: [['unit', 'uuid']],
  return_unit: [['unit', 'uuid'], ['note', 'text']],
  withdraw_unit: [['unit', 'uuid']],
  save_time_log: [['period', 'date'], ['items', 'jsonb']],
  confirm_time_logs: [['project', 'uuid'], ['period', 'date']],
  save_biweekly_report: [['project', 'uuid'], ['period', 'date'], ['stage', 'text'], ['question', 'text'], ['done', 'text'], ['changed', 'text'], ['issues', 'text'], ['division', 'text'], ['next', 'text']],
  set_pool_cap: [['project', 'uuid'], ['cap', 'numeric']],
  submit_outcome: [['project', 'uuid'], ['level', 'int'], ['link', 'text'], ['venue', 'text'], ['note', 'text']],
  check_outcome: [['id', 'uuid'], ['ok', 'boolean'], ['note', 'text']],
  set_token_param: [['key', 'text'], ['value', 'jsonb']],
  set_tier_token: [['tier', 'uuid'], ['amount', 'numeric']],
  reject_tier: [['year', 'int'], ['project', 'uuid'], ['note', 'text'], ['on', 'date']],
  settle_tiers: [['year', 'int']],
  unsettle_tiers: [['year', 'int']],
  set_project_morningstar: [['id', 'uuid'], ['on', 'boolean']],
  save_project: [['id', 'uuid'], ['code', 'text'], ['name', 'text'], ['kind', 'text'], ['owner_id', 'uuid'], ['active', 'boolean'], ['parent_id', 'uuid']],
  save_budget_category: [['id', 'uuid'], ['code', 'text'], ['name', 'text'], ['labor', 'boolean'], ['sort', 'int'], ['active', 'boolean']],
  open_budget_year: [['year', 'int'], ['due_date', 'date']],
  save_budget_line: [['id', 'uuid'], ['year', 'int'], ['project_id', 'uuid'], ['category_id', 'uuid'], ['purpose', 'text'], ['q1', 'numeric'], ['q2', 'numeric'], ['q3', 'numeric'], ['q4', 'numeric']],
  delete_budget_line: [['id', 'uuid']],
  set_project_budget: [['year', 'int'], ['project_id', 'uuid'], ['action', 'text'], ['note', 'text']],
  advance_budget_year: [['year', 'int'], ['action', 'text'], ['amount', 'numeric'], ['on_date', 'date']],
  adjust_budget_line: [['id', 'uuid'], ['amount', 'numeric'], ['note', 'text']],
  set_category_subjects: [['category_id', 'uuid'], ['subjects', 'jsonb']],
  allocate_line: [['id', 'uuid'], ['parts', 'jsonb']],
  auto_allocate: [['year', 'int']],
  submit_project_request: [['line_id', 'uuid'], ['expense_type_id', 'uuid'], ['title', 'text'], ['amount', 'numeric'], ['eta_date', 'date'], ['emergency', 'boolean'], ['path', 'text'], ['unit_id', 'uuid']],
  set_request_line: [['id', 'uuid'], ['line_id', 'uuid']],
  review_project: [['year', 'int'], ['quarter', 'int'], ['project_id', 'uuid'], ['note', 'text']],
  revise_fixed: [['id', 'uuid'], ['amount', 'numeric'], ['note', 'text']],
  submit_split: [['expense_type_id', 'uuid'], ['title', 'text'], ['eta_date', 'date'], ['path', 'text'], ['parts', 'jsonb']],
  save_resource: [['id', 'uuid'], ['kind', 'text'], ['name', 'text'], ['ref', 'text'], ['total', 'numeric'], ['unit', 'text'], ['note', 'text'], ['active', 'boolean']],
  allocate_resource: [['resource_id', 'uuid'], ['user_id', 'uuid'], ['quota', 'numeric'], ['from_date', 'date'], ['to_date', 'date'], ['note', 'text']],
  return_allocation: [['id', 'uuid'], ['returned_on', 'date']],
  set_resource_info: [['id', 'uuid'], ['info', 'jsonb']],
  stock_in: [['resource_id', 'uuid'], ['qty', 'numeric'], ['unit_price', 'numeric'], ['received_on', 'date'], ['supplier', 'text'], ['note', 'text'], ['request_id', 'uuid']],
  set_allocation_info: [['id', 'uuid'], ['used', 'numeric'], ['used_on', 'date'], ['asset_no', 'text'], ['location', 'text']],
  save_resource_request: [['id', 'uuid'], ['kind', 'text'], ['resource_id', 'uuid'], ['line_id', 'uuid'], ['amount', 'numeric'], ['period', 'date'],
    ['purpose', 'text'], ['usage_note', 'text'], ['urgent', 'boolean'], ['unit_id', 'uuid']],
  decide_resource_request: [['id', 'uuid'], ['action', 'text'], ['amount', 'numeric'], ['note', 'text']],
  fulfil_resource_request: [['id', 'uuid'], ['resource_id', 'uuid'], ['to_date', 'date'], ['note', 'text']],
  save_petty_cash: [['id', 'uuid'], ['amount', 'numeric'], ['purpose', 'text'], ['line_id', 'uuid'], ['unit_id', 'uuid']],
  set_line_resource: [['line_id', 'uuid'], ['resource_id', 'uuid'], ['qty', 'numeric']],
  decide_petty_cash: [['id', 'uuid'], ['action', 'text'], ['note', 'text']],
  settle_petty_cash: [['id', 'uuid'], ['spent', 'numeric'], ['settled_on', 'date'], ['note', 'text'], ['request_id', 'uuid']],
  set_card_info: [['card_id', 'uuid'], ['fund_kind', 'text'], ['received', 'numeric'], ['priority', 'int']],
  record_expense: [['card_id', 'uuid'], ['subject_id', 'uuid'], ['expense_type_id', 'uuid'], ['title', 'text'], ['amount', 'numeric'], ['posted_on', 'date'], ['voucher_no', 'text'], ['line_id', 'uuid']],
  record_expenses: [['rows', 'jsonb']],
  set_card_total: [['card_id', 'uuid'], ['total', 'numeric'], ['period_start', 'date'], ['period_end', 'date']],
  save_fund_project: [['id', 'uuid'], ['name', 'text'], ['source', 'text'], ['fund_kind', 'text'], ['owner_id', 'uuid'], ['quota', 'numeric'], ['period_start', 'date'], ['period_end', 'date'], ['template_id', 'uuid'], ['end_rule', 'text'], ['note', 'text']],
  open_card: [['project_id', 'uuid'], ['year', 'int'], ['card_no', 'text'], ['applied', 'numeric'], ['start_date', 'date'], ['cutoff_date', 'date'], ['settle_date', 'date'], ['name', 'text']],
  set_card_applied: [['card_id', 'uuid'], ['applied', 'numeric']],
  set_card_granted: [['card_id', 'uuid'], ['granted', 'numeric']],
  import_ledger: [['card_id', 'uuid'], ['rows', 'jsonb'], ['incomes', 'jsonb'], ['opening', 'numeric'], ['balance', 'numeric'], ['pooled', 'boolean']],
  register_inflight: [['card_id', 'uuid'], ['title', 'text'], ['amount', 'numeric'], ['spent_on', 'date'], ['state', 'text'], ['subject_id', 'uuid'], ['user_id', 'uuid'], ['note', 'text']],
  void_stray_posted: [['card_id', 'uuid']],
  set_card_pooled: [['card_id', 'uuid'], ['pooled', 'boolean']],
  close_fund_project: [['id', 'uuid']],
  set_project_close_rule: [['id', 'uuid'], ['rule', 'text']],
  move_card: [['card_id', 'uuid'], ['project_id', 'uuid']],
  delete_card: [['card_id', 'uuid']],
  delete_fund_project: [['id', 'uuid']],
  add_project_member: [['project_id', 'uuid'], ['user_id', 'uuid']],
  remove_project_member: [['project_id', 'uuid'], ['user_id', 'uuid']],
  recall_project_allocation: [['id', 'uuid']],
  set_project_cap: [['year', 'int'], ['project_id', 'uuid'], ['amount', 'numeric']],
  request_cap: [['year', 'int'], ['project_id', 'uuid'], ['amount', 'numeric'], ['reason', 'text']],
  decide_cap_request: [['id', 'uuid'], ['ok', 'boolean'], ['amount', 'numeric'], ['note', 'text']],
  confirm_request: [['id', 'uuid'], ['ok', 'boolean'], ['note', 'text']],
  check_request: [['id', 'uuid'], ['ok', 'boolean'], ['note', 'text']],
  shift_budget: [['from_line', 'uuid'], ['to_line', 'uuid'], ['amount', 'numeric'], ['note', 'text']],
  decide_budget_shift: [['id', 'uuid'], ['ok', 'boolean'], ['note', 'text']],
  move_budget: [['from_line', 'uuid'], ['to_line', 'uuid'], ['amount', 'numeric'], ['note', 'text']],
  create_task: [['title', 'text'], ['assignee', 'uuid'], ['due', 'date'], ['card_id', 'uuid'], ['detail', 'text'], ['steps', 'text']],
  edit_task: [['id', 'uuid'], ['title', 'text'], ['assignee', 'uuid'], ['due', 'date'], ['detail', 'text']],
  add_task_steps: [['id', 'uuid'], ['steps', 'text']],
  tick_task_step: [['step', 'uuid'], ['done', 'boolean'], ['note', 'text']],
  finish_task: [['id', 'uuid'], ['note', 'text']],
  revoke_api_token: [['id', 'uuid']],
  cancel_task: [['id', 'uuid'], ['note', 'text']],
  reopen_task: [['id', 'uuid'], ['note', 'text']],
  save_year_check: [['year', 'int'], ['resource_id', 'uuid'], ['actual', 'numeric'], ['note', 'text']],
};

const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(secret: string, msg: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
// ---------- GitHub 事件 ----------
// 只发中台分支上的 PR：开出（草稿转为待审也算）、重新打开、提交审查、合并或关闭。其余事件不发
export const GITHUB_BASE = 'finance-portal';
// 一个 PR 一个话题：thread 是话题的键，同一个 PR 的通报都回复在它第一条通报的话题里
export function githubText(event: string, p: any): { text: string; url: string; btn: string; thread: string } | null {
  const n = githubBody(event, p);
  return n ? { ...n, thread: `pr:${Number(p.pull_request.number)}` } : null;
}
function githubBody(event: string, p: any): { text: string; url: string; btn: string } | null {
  const pr = p?.pull_request;
  if (!pr || pr.base?.ref !== GITHUB_BASE || !Number.isInteger(pr.number) || pr.number <= 0) return null;
  const head = `#${pr.number} ${String(pr.title ?? '').slice(0, 120)}`, url = String(pr.html_url ?? '');
  if (!/^https:\/\/github\.com\//.test(url)) return null;
  const who = (u: any) => String(u?.login ?? '—');
  const line = `提交人 ${who(pr.user)} · 分支 ${pr.head?.ref ?? '—'} → ${GITHUB_BASE}`;
  if (event === 'pull_request') {
    const a = p.action;
    if ((a === 'opened' && !pr.draft) || a === 'ready_for_review') return { text: `PR 待审：${head}\n${line}`, url, btn: '查看 PR' };
    if (a === 'reopened') return { text: `PR 重新打开：${head}\n${line}`, url, btn: '查看 PR' };
    if (a === 'closed') return pr.merged
      ? { text: `PR 已合并：${head}\n合并人 ${who(pr.merged_by)} · ${line}`, url, btn: '查看 PR' }
      : { text: `PR 已关闭：${head}\n关闭人 ${who(p.sender)} · ${line}`, url, btn: '查看 PR' };
    return null;
  }
  if (event === 'pull_request_review' && p.action === 'submitted') {
    const r = p.review ?? {}, st = String(r.state ?? '').toLowerCase();
    const t = st === 'approved' ? 'PR 审查通过' : st === 'changes_requested' ? 'PR 要求修改' : st === 'commented' ? 'PR 审查意见' : null;
    if (!t) return null;
    const body = String(r.body ?? '').replace(/\r/g, '').trim();
    const brief = body ? `\n${body.length > 300 ? body.slice(0, 300) + '……' : body}` : '';
    const link = /^https:\/\/github\.com\//.test(String(r.html_url ?? '')) ? String(r.html_url) : url;
    return { text: `${t}：${head}\n审查人 ${who(r.user)} · ${line}${brief}`, url: link, btn: '查看审查' };
  }
  return null;
}
export async function githubSigned(secret: string, raw: string, sig: string | null) {
  if (!sig?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hex = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(raw)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return same(hex, sig.slice(7).toLowerCase());
}

function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function sign(secret: string, kind: string, value: string, ttlSeconds: number, now = Date.now()) {
  const body = `${kind}.${value}.${Math.floor(now / 1000) + ttlSeconds}`;
  return `${body}.${await hmac(secret, body)}`;
}
export async function verify(secret: string, kind: string, token: string | undefined, now = Date.now()) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== kind) return null;
  const body = parts.slice(0, 3).join('.');
  if (!same(parts[3], await hmac(secret, body))) return null;
  if (Number(parts[2]) < now / 1000) return null;
  return parts[1];
}

// ---------- 密钥与账号：明文只在这一层出现，进数据库之前加密 ----------
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function vaultKey(secret: string) {
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode(secret)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(secret: string, owner: string, plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(owner) }, await vaultKey(secret), enc.encode(plain));
  return `v1.${b64u(iv)}.${b64u(ct)}`;
}
export async function unseal(secret: string, owner: string, cipher: string) {
  const [v, iv, ct] = cipher.split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('bad cipher');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv), additionalData: enc.encode(owner) }, await vaultKey(secret), unb64u(ct));
  return new TextDecoder().decode(pt);
}
export const mask = (s: string) => (s.length >= 12 ? `${s.slice(0, 3)}…${s.slice(-4)}` : '已保存');

// 卡片上的办理凭据：30 天内有效
export const ACT_TTL = 30 * 86400;
// 会话有效期：30 天，每次打开页面顺延
export const SESSION_TTL = 30 * 86400;
// 登录后要回到的页面：只认站内路径，其余一律回首页
export const safeTo = (s: string | null | undefined) => (s && /^\/[A-Za-z0-9_\-\/]{0,120}$/.test(s) ? s : '/');

const cookies = (req: Request) =>
  Object.fromEntries((req.headers.get('cookie') ?? '').split(/;\s*/).filter(Boolean).map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i), c.slice(i + 1)];
  }));
const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

// 标志图在飞书里的图片标识，本进程内上传一次后记住
const markKeys: { red?: string; white?: string } = {};
// 飞书会议自动签到：按会议号查飞书会议，读参会的飞书用户和录制，交给数据库对上中台账号签到
async function zoomToken(env: Env) {
  if (!env.ZOOM_ACCOUNT_ID || !env.ZOOM_CLIENT_ID || !env.ZOOM_CLIENT_SECRET) return null;
  const r = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(env.ZOOM_ACCOUNT_ID)}`, {
    method: 'POST', headers: { authorization: `Basic ${btoa(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`)}` } }).then((x) => x.json() as Promise<any>).catch(() => null);
  return r?.access_token ? String(r.access_token) : null;
}
async function meetingSync(env: Env) {
  const tok = await feishu('/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: env.FEISHU_BOT_APP_ID || env.FEISHU_APP_ID, app_secret: env.FEISHU_BOT_APP_SECRET || env.FEISHU_APP_SECRET }) }).catch(() => null);
  const auth = { authorization: `Bearer ${tok?.tenant_access_token ?? ''}` };
  // 中心日历：开着、没挂会议号的会，到日历里找同一时段、标题对得上的飞书会议
  const cal = await withUser(env, null, (sql) => sql`select event_id, kind, seminar_name, title, from_ts, to_ts, calendar_id from public.calendar_todo()`).catch(() => []);
  if (cal.length && tok?.tenant_access_token) {
    const c0 = cal[0];
    let calId = String(c0.calendar_id);
    // 填的是日历名称的，按名称搜公开日历取编号
    if (!calId.includes('@')) {
      const sr = await feishu('/calendar/v4/calendars/search?page_size=20', { method: 'POST', headers: { ...auth, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ query: calId }) }).catch(() => null);
      const hit = ((sr?.data?.items ?? []) as { calendar_id?: string; summary?: string }[]).find((x) => x.summary === calId) ?? (sr?.data?.items ?? [])[0];
      if (hit?.calendar_id) calId = String(hit.calendar_id); else console.error('中心日历按名称没有搜到', sr?.code, sr?.msg);
    }
    const ev = await feishu(`/calendar/v4/calendars/${encodeURIComponent(calId)}/events?start_time=${Math.min(...cal.map((c: any) => Number(c.from_ts)))}&end_time=${Math.max(...cal.map((c: any) => Number(c.to_ts)))}&page_size=100`, { headers: auth }).catch(() => null);
    const items = (ev?.code === 0 ? ev.data?.items ?? [] : []) as { summary?: string; description?: string; location?: { name?: string; address?: string }; start_time?: { timestamp?: string }; vchat?: { meeting_url?: string; vc_type?: string } }[];
    // 日程里的 Zoom 链接：会议链接、地点、描述里都可能写着
    const zoomOf = (i: (typeof items)[number]) => `${i.vchat?.meeting_url ?? ''} ${i.location?.name ?? ''} ${i.location?.address ?? ''} ${i.description ?? ''}`.match(/zoom\.(?:us|com\.cn)\/j\/(\d{9,12})/)?.[1];
    for (const c of cal) {
      const key = c.kind === 'seminar' ? String(c.seminar_name ?? '') : c.kind === 'lecture' ? '讲座' : c.kind === 'council' ? '联席' : '';
      const hit = items.find((i) => Number(i.start_time?.timestamp ?? 0) >= Number(c.from_ts) && Number(i.start_time?.timestamp ?? 0) <= Number(c.to_ts)
        && ((c.title && String(i.summary ?? '').includes(String(c.title))) || (key && String(i.summary ?? '').includes(key))) && (i.vchat?.meeting_url || zoomOf(i)));
      if (!hit) continue;
      const zid = zoomOf(hit);
      if (zid) { await withUser(env, null, (sql) => sql`select public.calendar_link_zoom(${c.event_id}::uuid, ${zid})`).catch(() => null); continue; }
      const no = /feishu|larksuite/.test(hit.vchat?.meeting_url ?? '') ? hit.vchat!.meeting_url!.replace(/[^0-9]/g, '').slice(-9) : '';
      if (no) await withUser(env, null, (sql) => sql`select public.calendar_link(${c.event_id}::uuid, ${no})`).catch(() => null);
    }
  }
  const todo = await withUser(env, null, (sql) => sql`select event_id, feishu_no, zoom_id, from_ts, to_ts, has_minutes, ended from public.meeting_sync_todo()`);
  if (!todo.length) return;
  const why = (x: any, hint: string) => `飞书返回 ${x?.code ?? '无'}：${String(x?.msg ?? '').slice(0, 80)}${hint}`;
  let ztok: string | null | undefined;
  for (const t of todo) {
    if (t.zoom_id) {
      // Zoom：散会后读参会报告；按邮箱、姓名对上
      let note = ''; let minutes: string | null = null; const names: string[] = []; const emails: string[] = [];
      if (ztok === undefined) ztok = await zoomToken(env);
      if (!ztok) note = '未配置 Zoom 的服务端应用凭证，或凭证不对';
      else if (!t.ended) note = '散会后读 Zoom 的参会报告';
      else {
        let next = '';
        for (let i = 0; i < 10; i++) {
          const r = await fetch(`https://api.zoom.us/v2/report/meetings/${t.zoom_id}/participants?page_size=300${next ? `&next_page_token=${encodeURIComponent(next)}` : ''}`, { headers: { authorization: `Bearer ${ztok}` } }).then((x) => x.json() as Promise<any>).catch(() => null);
          if (!r || !Array.isArray(r.participants)) { note = `Zoom 返回 ${r?.code ?? '无'}：${String(r?.message ?? '').slice(0, 80)}（确认应用有 report:read:admin 权限、账号为付费版）`; break; }
          for (const pt of r.participants as { name?: string; user_email?: string }[]) { names.push(String(pt.name ?? '')); emails.push(String(pt.user_email ?? '')); }
          next = String(r.next_page_token ?? ''); if (!next) break;
        }
        if (!t.has_minutes) {
          const rec = await fetch(`https://api.zoom.us/v2/meetings/${t.zoom_id}/recordings`, { headers: { authorization: `Bearer ${ztok}` } }).then((x) => x.json() as Promise<any>).catch(() => null);
          if (rec?.share_url) minutes = String(rec.share_url);
        }
        if (!note) note = `Zoom 参会 ${new Set(names).size} 人${minutes ? '，已挂上云录制' : ''}`;
      }
      await withUser(env, null, (sql) => sql`select public.meeting_sync_save(${t.event_id}::uuid, null, ${minutes}, ${note},
        array(select jsonb_array_elements_text(${JSON.stringify(emails)}::text::jsonb)), array(select jsonb_array_elements_text(${JSON.stringify(names)}::text::jsonb)))`).catch((e) => console.error('Zoom 同步', e));
      continue;
    }
    let note = ''; let minutes: string | null = null; const ids = new Set<string>();
    if (!tok?.tenant_access_token) note = '取不到正则的应用凭证';
    else {
      const list = await feishu(`/vc/v1/meetings/list_by_no?meeting_no=${t.feishu_no}&start_time=${t.from_ts}&end_time=${t.to_ts}&page_size=20`, { headers: auth }).catch((e) => ({ code: -1, msg: String(e) }));
      if (list?.code !== 0) note = why(list, '（正则可能尚未开通视频会议的读取权限 vc:meeting:readonly）');
      else {
        const briefs = (list.data?.meeting_briefs ?? []) as { id?: string }[];
        if (!briefs.length) note = '飞书上还没有找到这个会议号在这段时间开过的会';
        for (const b of briefs) {
          if (!b.id) continue;
          const g = await feishu(`/vc/v1/meetings/${b.id}?with_participants=true&user_id_type=union_id`, { headers: auth }).catch((e) => ({ code: -1, msg: String(e) }));
          if (g?.code !== 0) { note = why(g, '（读参会名单失败）'); continue; }
          for (const pt of (g.data?.meeting?.participants ?? []) as { id?: string; user_type?: number }[]) if (pt.id && pt.user_type === 1) ids.add(pt.id);
          if (!t.has_minutes && !minutes && String(g.data?.meeting?.status) === '3') {
            const r = await feishu(`/vc/v1/meetings/${b.id}/recording`, { headers: auth }).catch(() => null);
            if (r?.code === 0 && r.data?.recording?.url) minutes = String(r.data.recording.url);
            else if (r && r.code !== 124002) note = (note ? note + '；' : '') + why(r, '（读录制失败，确认会议开了录制、正则有 vc:record:readonly 权限）');
          }
        }
        if (!note) note = `飞书会议 ${briefs.length} 场，参会的飞书用户 ${ids.size} 人${minutes ? '，已挂上录制' : ''}`;
      }
    }
    await withUser(env, null, (sql) => sql`select public.meeting_sync_save(${t.event_id}::uuid, array(select jsonb_array_elements_text(${JSON.stringify([...ids])}::text::jsonb)), ${minutes}, ${note})`).catch((e) => console.error('会议同步', e));
  }
}

// ---------- 录音补漏：散会后取逐字稿，找出会上提的质疑，作为草稿交组织者记入 ----------
// Zoom 的逐字稿是 WebVTT，转成「[分:秒] 姓名：话」一行一句
export function vttToText(vtt: string) {
  const out: string[] = [];
  let at = '';
  for (const line of vtt.replace(/\r/g, '').split('\n')) {
    const t = line.match(/^(\d{2}):(\d{2}):(\d{2})\.\d{3}\s+-->/);
    if (t) { at = `${Number(t[1]) * 60 + Number(t[2])}:${t[3]}`; continue; }
    if (!line.trim() || line === 'WEBVTT' || /^\d+$/.test(line.trim())) continue;
    out.push(`[${at}] ${line.trim()}`);
  }
  return out.join('\n');
}
async function transcriptSync(env: Env) {
  const todo = await withUser(env, null, (sql) => sql`select event_id, zoom_id, minutes_link from public.transcript_todo()`).catch(() => []);
  let tok: string | null | undefined; let ztok: string | null | undefined;
  for (const t of todo) {
    let body: string | null = null; let note = ''; let source: 'feishu' | 'zoom' | null = null;
    if (t.zoom_id) {
      source = 'zoom';
      if (ztok === undefined) ztok = await zoomToken(env);
      if (!ztok) note = '未配置 Zoom 的服务端应用凭证';
      else {
        const rec = await fetch(`https://api.zoom.us/v2/meetings/${t.zoom_id}/recordings`, { headers: { authorization: `Bearer ${ztok}` } }).then((x) => x.json() as Promise<any>).catch(() => null);
        const f = ((rec?.recording_files ?? []) as { file_type?: string; download_url?: string; status?: string }[]).find((x) => x.file_type === 'TRANSCRIPT' && x.download_url);
        if (!f) note = rec?.recording_files ? 'Zoom 云录制还没有生成逐字稿（须在 Zoom 设置里开启音频转写）' : `Zoom 返回 ${rec?.code ?? '无'}：${String(rec?.message ?? '').slice(0, 80)}`;
        else {
          const r = await fetch(f.download_url!, { headers: { authorization: `Bearer ${ztok}` } }).catch(() => null);
          if (r?.ok) body = vttToText(await r.text()); else note = `下载 Zoom 逐字稿失败 ${r?.status ?? ''}`;
        }
      }
    } else {
      source = 'feishu';
      const mt = String(t.minutes_link ?? '').match(/\/minutes\/([0-9a-zA-Z]+)/)?.[1];
      if (tok === undefined) {
        const r = await feishu('/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ app_id: env.FEISHU_BOT_APP_ID || env.FEISHU_APP_ID, app_secret: env.FEISHU_BOT_APP_SECRET || env.FEISHU_APP_SECRET }) }).catch(() => null);
        tok = r?.tenant_access_token ? String(r.tenant_access_token) : null;
      }
      if (!mt) note = '纪要链接不是飞书妙记';
      else if (!tok) note = '取不到正则的应用凭证';
      else {
        const r = await fetch(`https://open.feishu.cn/open-apis/minutes/v1/minutes/${mt}/transcript?need_speaker=true&need_timestamp=true&file_format=txt`, { headers: { authorization: `Bearer ${tok}` } }).catch(() => null);
        const ct = r?.headers.get('content-type') ?? '';
        if (r?.ok && !ct.includes('json')) body = await r.text();
        else { const j = r ? await r.json().catch(() => null) as any : null; note = `飞书返回 ${j?.code ?? r?.status ?? '无'}：${String(j?.msg ?? '').slice(0, 80)}（妙记可能还在生成，或正则没有这份妙记的读取权限）`; }
      }
    }
    if (body) note = `已取到逐字稿，${body.length} 字`;
    await withUser(env, null, (sql) => sql`select public.transcript_save(${t.event_id}::uuid, ${source}, ${body}, ${note})`).catch((e) => console.error('存逐字稿', e));
  }
  if (env.ANTHROPIC_API_KEY) await extractQueries(env).catch((e) => console.error('提取质疑', e));
}

const AXIS_GUIDE = '理（li）：为什么读者要关注这个问题；据（ju）：为什么别人没有解决；体（ti）：为什么你能解决（方法、证据是否站得住）；用（yong）：为什么别人要关注你的解决和发现';
async function extractQueries(env: Env) {
  const [row] = await withUser(env, null, (sql) => sql`select event_id, seminar_name, held_on, body, pitches, attendees from public.transcript_extract_todo()`);
  if (!row) return;
  const pitches = row.pitches as { id: string; label: string; format: string | null; authors: string[] }[];
  if (!pitches.length) { await withUser(env, null, (sql) => sql`select public.transcript_drafts_save(${row.event_id}::uuid, '[]'::jsonb, '这场会没有可对应的快照')`); return; }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const list = pitches.map((p, i) => `${i + 1}. ${p.label}（${p.format === 'poster' ? '海报' : '口头报告'}；汇报人：${p.authors.join('、') || '未登记'}）`).join('\n');
  const schema = { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['pitch', 'speaker', 'axis', 'body', 'quote'], properties: {
      pitch: { type: 'integer', description: '针对的是第几份报告（从 1 开始）' },
      speaker: { type: 'string', description: '提出质疑的人，按逐字稿里的发言人姓名原样写' },
      axis: { type: 'string', enum: ['li', 'ju', 'ti', 'yong'] },
      body: { type: 'string', description: '质疑的内容，改写成一句完整、独立能看懂的问题，不超过 120 字' },
      quote: { type: 'string', description: '逐字稿里对应的原话，不超过 150 字' } } } } } };
  const res = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: { type: 'json_schema', schema } },
    system: `你在整理中心主题研讨会的录音逐字稿。研讨会上，每份报告讲完后与会者对它提质疑，质疑分四问：${AXIS_GUIDE}。\n你的任务：找出与会者对每份报告提出的质疑（问题、反对意见、要求补充的地方），每条记下是谁提的、针对哪份报告、属于哪一问。\n只收与会者向汇报人提出的质疑；汇报人自己的陈述和回答、主持人的串场、寒暄、技术问题都不收。同一个人对同一份报告反复说的同一点只记一条。拿不准针对哪份报告的，按发言时间对应当时正在讲的那份。没有找到就返回空数组。`,
    messages: [{ role: 'user', content: `${row.held_on} ${row.seminar_name}主题研讨会。\n按讨论顺序，这场会的报告：\n${list}\n\n到场的人：${(row.attendees as string[]).join('、') || '未知'}\n\n逐字稿：\n${row.body}` }],
  } as any) as any;
  if (res.stop_reason === 'refusal') { await withUser(env, null, (sql) => sql`select public.transcript_drafts_save(${row.event_id}::uuid, '[]'::jsonb, '模型没有处理这份逐字稿')`); return; }
  const text = (res.content as { type: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  let items: { pitch: number; speaker: string; axis: string; body: string; quote: string }[] = [];
  try { items = JSON.parse(text).items ?? []; } catch { console.error('提取结果不是 JSON', res.stop_reason); return; }
  const mapped = items.filter((x) => Number.isInteger(x.pitch) && pitches[x.pitch - 1]).map((x) => ({ pitch: pitches[x.pitch - 1].id, speaker: x.speaker, axis: x.axis, body: x.body, quote: x.quote }));
  const note = `自动提取 ${items.length} 条（${res.model}，输入 ${res.usage?.input_tokens ?? '?'}、输出 ${res.usage?.output_tokens ?? '?'} tokens）`;
  await withUser(env, null, (sql) => sql`select public.transcript_drafts_save(${row.event_id}::uuid, ${JSON.stringify(mapped)}::jsonb, ${note})`);
}

async function feishu(path: string, init: RequestInit) {
  const r = await fetch('https://open.feishu.cn/open-apis' + path, init);
  return (await r.json()) as any;
}

// 连接不取类型表，数组列回来是 {a,b} 这样的字符串，这里还原成数组
const ARRAY_OIDS = new Set([1000, 1005, 1007, 1009, 1015, 1016, 1182, 1231, 2951]);
export function pgArray(v: unknown): unknown {
  if (typeof v !== 'string' || v[0] !== '{' || v[v.length - 1] !== '}') return v;
  const out: (string | null)[] = [];
  let i = 1;
  while (i < v.length - 1) {
    if (v[i] === ',') { i++; continue; }
    if (v[i] === '"') {
      let s = '';
      for (i++; i < v.length && v[i] !== '"'; i++) s += v[i] === '\\' ? v[++i] : v[i];
      out.push(s); i++;
    } else {
      let j = i;
      while (j < v.length - 1 && v[j] !== ',') j++;
      const s = v.slice(i, j);
      out.push(s === 'NULL' ? null : s); i = j;
    }
  }
  return out;
}
function fixArrays<R extends Record<string, unknown>>(rows: R[] & { columns?: { name: string; type: number }[] }): R[] {
  const cols = (rows.columns ?? []).filter((c) => ARRAY_OIDS.has(c.type)).map((c) => c.name);
  if (cols.length === 0) return rows;
  return rows.map((r) => { const o: Record<string, unknown> = { ...r }; for (const c of cols) o[c] = pgArray(o[c]); return o as R; });
}

async function withUser<T>(env: Env, uid: string | null, fn: (sql: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const sql = postgres(env.HYPERDRIVE.connectionString, { max: 1, fetch_types: false, prepare: false });
  try {
    return (await sql.begin(async (tx) => {
      await tx`select set_config('app.uid', ${uid ?? ''}, true)`;
      return fn(tx);
    })) as T;
  } finally {
    await sql.end({ timeout: 1 });
  }
}


// ---------- 飞书通知卡片 ----------
// 通知在数据库里是一句话。这里按句式给出标题、分项和跳转的页面，拼成卡片；认不出的句式整句放进正文。
const NOTICE_RULES: [RegExp, string, string][] = [
  [/ARR 担保/, 'ARR 担保', '/'],
  [/^身份认定/, '身份认定', '/path'],
  [/^主线任务已认定/, '成长主线', '/path'],
  [/^主线任务认定已撤销/, '成长主线', '/path'],
  [/^研讨会组织者/, '研讨会组织者', '/iterate'],
  [/^快照待接收/, '待接收的快照', '/iterate'],
  [/^快照已接收/, '快照已接收', '/iterate'],
  [/^快照未接收/, '快照未接收', '/iterate'],
  [/^质疑小队/, '质疑小队', '/iterate'],
  [/^入队申请/, '入队申请待办', '/iterate'],
  [/^质疑已回应/, '质疑已回应', '/iterate'],
  [/^研讨会讨论结束/, '研讨会讨论结束', '/iterate'],
  [/^考核申请/, '考核申请待办理', '/path'],
  [/^考核待决定/, '待决定的考核', '/path'],
  [/^RA 考核：小任务已布置/, '待完成的 RA 小任务', '/path'],
  [/考核未通过|认定未通过/, '考核未通过', '/path'],
  [/^德行记入/, '德行记入', '/path'],
  [/^审阅意见/, '审阅意见', '/iterate'],
  [/^嘉许/, '嘉许', '/'],
  [/^实际币投入/, '实际币投入', '/projects'],
  [/^主线草稿/, '主线草稿', '/iterate'],
  [/^研究单元停滞|^研究单元应予终止/, '研究单元停滞', '/projects'],
  [/^(研究单元|课题)改名/, '改名', '/projects'],
  [/研究单元申请待同意/, '研究单元申请待同意', '/projects'],
  [/研究单元立项/, '研究单元立项提醒', '/projects'],
  [/研究单元申请待核对|待助理对照联席会议纪要核对/, '研究单元申请待核对', '/projects'],
  [/研究单元申请「」已退回/, '研究单元申请已退回', '/projects'],
  [/研究单元「」已成立|新成立研究单元/, '研究单元已成立', '/projects'],
  [/研究单元「」.*成员名单/, '研究单元成员名单', '/projects'],
  [/双周表/, '双周表', '/biweekly'],
  [/任务/, '任务', '/tasks'],
  [/年度立项申请|延续申请/, '立项与延续申请', '/apply'],
  [/评定/, '年度评定', '/plan'],
  [/备用金/, '备用金', '/petty'],
  [/支出申请|报销|垫付/, '支出申请', '/requests'],
  [/人事确认|人员档案/, '人员档案', '/people'],
  [/资源|额度/, '资源申领', '/resource'],
  [/预算/, '年度预算', '/budget'],
];
const NOTICE_FIELDS: [RegExp, string[]][] = [
  [/([^\s：]+) 申请在课题「(.+?)」之下成立「(.+?)」/, ['申请人', '所挂课题', '研究单元']],
  [/([^\s：]+) 申请成立「(.+?)」，挂在课题「(.+?)」之下/, ['申请人', '研究单元', '所挂课题']],
  [/研究单元「(.+?)」已成立，挂在课题「(.+?)」之下/, ['研究单元', '所挂课题']],
  [/课题「(.+?)」之下新成立研究单元「(.+?)」/, ['所挂课题', '研究单元']],
  [/联席会议 (\d{4}-\d{2}-\d{2}) 通过/, ['联席会议通过']],
];
// 指向中台页面的链接改走飞书的应用链接，在飞书里打开网页应用并直达该页；其他链接（如知识库）不动。没有应用标识时保持原链接
export const inFeishu = (u: string, origin: string, appId?: string) =>
  appId && (u === origin || u.startsWith(origin + '/'))
    ? `https://applink.feishu.cn/client/web_app/open?appId=${encodeURIComponent(appId)}&lk_target_url=${encodeURIComponent(u)}` : u;
// 双周表的飞书任务：把数据库给出的一条计划变成对飞书任务接口的一次调用
export function taskCall(row: { act: string; target_id: string; summary: string; due: string; task_guid: string | null }, origin: string, appId?: string, now = Date.now()) {
  if (row.act === 'create') {
    const [y, m, d] = String(row.due).slice(0, 10).split('-').map(Number);
    return { method: 'POST', path: `/task/v2/tasks?user_id_type=${row.target_id.startsWith('on_') ? 'union_id' : 'open_id'}`, body: {
      summary: row.summary, description: '登记后这条任务会自动完成。',
      due: { timestamp: String(Date.UTC(y, m - 1, d)), is_all_day: true },
      members: [{ id: row.target_id, type: 'user', role: 'assignee' }],
      origin: { platform_i18n_name: { zh_cn: '正则' }, href: { url: inFeishu(`${origin}/#/biweekly`, origin, appId), title: '去登记双周表' } } } };
  }
  if (!row.task_guid || !/^[\w-]{8,80}$/.test(row.task_guid)) return null;
  if (row.act === 'done') return { method: 'PATCH', path: `/task/v2/tasks/${row.task_guid}`, body: { task: { completed_at: String(now) }, update_fields: ['completed_at'] } };
  if (row.act === 'drop') return { method: 'DELETE', path: `/task/v2/tasks/${row.task_guid}`, body: undefined };
  return null;
}
async function biweeklyTasks(env: Env) {
  // 新任务不在后半夜建（北京时间 0 点到 7 点），完成和撤掉随时办
  const hour = (new Date().getUTCHours() + 8) % 24;
  const rows = await withUser(env, null, (sql) => sql`select act, project_id, period_start::text as period_start, target_id, summary, due::text as due, task_guid from public.biweekly_task_plan(${hour >= 7}::boolean)`);
  if (!rows.length) return;
  const tok = await feishu('/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: env.FEISHU_BOT_APP_ID || env.FEISHU_APP_ID, app_secret: env.FEISHU_BOT_APP_SECRET || env.FEISHU_APP_SECRET }) }).catch(() => null);
  const out: [string, string, string, boolean, string | null, string | null][] = [];
  for (const r of rows as any[]) {
    const call = tok?.tenant_access_token ? taskCall(r, env.NOTICE_ORIGIN || 'https://clain-finance.pages.dev', env.FEISHU_APP_ID) : null;
    if (!call) { out.push([r.project_id, r.period_start, r.act, false, null, tok?.tenant_access_token ? '任务编号无效' : '无法获取应用凭证']); continue; }
    const res = await feishu(call.path, { method: call.method, headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${tok.tenant_access_token}` },
      body: call.body ? JSON.stringify(call.body) : undefined }).catch((e) => ({ code: -1, msg: String(e?.message ?? e) }));
    // 撤任务时飞书说已经不存在的，也算办完
    const fine = res?.code === 0 || (r.act !== 'create' && /not.?found|不存在|deleted/i.test(String(res?.msg ?? '')));
    out.push([r.project_id, r.period_start, r.act, fine, r.act === 'create' ? (res?.data?.task?.guid ?? null) : null, fine ? null : `飞书返回 ${res?.code}：${String(res?.msg ?? '').slice(0, 200)}`]);
  }
  await withUser(env, null, async (sql) => {
    for (const [pid, ps, act, okv, guid, err] of out) await sql`select public.biweekly_task_mark(${pid}::uuid, ${ps}::date, ${act}::text, ${okv && (act !== 'create' || !!guid)}::boolean, ${guid}::text, ${err ?? (okv ? null : '飞书没有返回任务编号')}::text)`;
  });
}
// 卡片配色取自网页的色系，浅色和深色各一个值
const rgba = (l: string, d: string) => ({ light_mode: `rgba(${l},1)`, dark_mode: `rgba(${d},1)` });
const CARD_COLORS = {
  'zz-brand': rgba('188,68,43', '232,128,104'), 'zz-raise': rgba('243,243,240', '44,44,46'), 'zz-ink': rgba('22,23,26', '240,240,238'),
  'zz-mute': rgba('106,110,117', '160,164,170'), 'zz-ok': rgba('31,122,77', '110,200,150'), 'zz-bad': rgba('180,35,24', '240,120,110'), 'zz-bad-bg': rgba('253,243,242', '64,30,28'), 'zz-ok-bg': rgba('240,248,243', '28,52,40'),
  'zz-gold-bar': rgba('243,217,164', '110,80,20'), 'zz-gold-ink': rgba('74,48,0', '255,240,205'), 'zz-ok-bar': rgba('216,238,225', '30,70,50'), 'zz-bad-bar': rgba('250,222,219', '90,34,30'),
  'zz-line': rgba('230,230,226', '70,70,72'), 'zz-track': rgba('200,200,194', '90,90,92'),
  'zz-ink-bar': rgba('22,23,26', '60,60,64'), 'zz-gold-tag': rgba('243,217,164', '243,217,164'), 'zz-on-dark': rgba('255,255,255', '255,255,255'), 'zz-on-dark-2': rgba('235,205,198', '235,205,198'), 'zz-on-ink-2': rgba('170,174,180', '190,194,200'),
};
// 六类通知：按收到的人要做什么分。顶栏底色、标题色、副行色、标签色、标签字、按钮样式、标志用白底的那张
export type NoticeKind = 'todo' | 'remind' | 'back' | 'pass' | 'fyi' | 'post';
const KIND: Record<NoticeKind, { bar: string; title: string; sub: string; tagColor: string; tag: string; btn: string; white?: boolean }> = {
  todo: { bar: 'zz-brand', title: 'zz-on-dark', sub: 'zz-on-dark-2', tagColor: 'zz-on-dark', tag: '待办', btn: 'default', white: true },
  remind: { bar: 'zz-gold-bar', title: 'zz-gold-ink', sub: 'zz-gold-ink', tagColor: 'zz-gold-ink', tag: '提醒', btn: 'default' },
  back: { bar: 'zz-bad-bar', title: 'zz-bad', sub: 'zz-bad', tagColor: 'zz-bad', tag: '已退回', btn: 'default' },
  pass: { bar: 'zz-ok-bar', title: 'zz-ok', sub: 'zz-ok', tagColor: 'zz-ok', tag: '已通过', btn: 'text' },
  fyi: { bar: 'zz-raise', title: 'zz-ink', sub: 'zz-mute', tagColor: 'zz-mute', tag: '知会', btn: 'text' },
  post: { bar: 'zz-ink-bar', title: 'zz-on-dark', sub: 'zz-on-ink-2', tagColor: 'zz-gold-tag', tag: '通报', btn: 'default' },
};
export type NoticeBody = { text?: string; by?: string | null; at?: string | null; url?: string | null; btn?: string | null; all?: boolean | null; group?: boolean | null; kind?: string | null; tag?: string | null;
  act?: { kind?: string; unit?: string } | null;   // 能在卡片上直接办的动作
  done?: string | null;                            // 已在卡片上办完：这句话替换掉按钮
  img?: string | null; img_key?: string | null; img_note?: string | null };   // 通报带的图：img 是图的 base64（PNG），发出前换成 img_key；img_note 是图下的小字
// 通知的内容：归类、标题、分项、正文、按钮。卡片和测试都从这里取
export function noticeView(body: NoticeBody, origin: string, appId?: string) {
  const own = typeof body.url === 'string' && /^https:\/\/[^\s]+$/.test(body.url) ? body.url : null;
  const text = String(body.text ?? '').trim(), bare = text.replace(/「[^」]*」/g, '「」');
  const rule = NOTICE_RULES.find(([re]) => re.test(bare));
  const head = text.match(/^([^：「」，。]{2,16})：/);
  const done = typeof body.done === 'string' && body.done.trim() ? body.done.trim().slice(0, 60) : null;
  const title = (head ? head[1] : rule ? rule[1] : '通知').replace(done ? /待同意$/ : /$^/, '已同意');
  const fields: [string, string][] = [];
  let rest = head ? text.slice(head[0].length) : text;
  for (const [re, names] of NOTICE_FIELDS) {
    const m = text.match(re);
    if (!m) continue;
    names.forEach((n, i) => { if (!fields.some(([k]) => k === n)) fields.push([n, m[i + 1]]); });
    rest = rest.replace(re, '');
  }
  if (fields.length) rest = rest.replace(/^[，。、\s]+/, '').replace(/[，、\s]*(课题负责人已同意)?[，、\s]*$/, (_, a) => (a ? a : '')).replace(/^，/, '');
  // 归类先看标题，标题看不出的再看正文里有没有要办的字样
  const given = done ? 'pass' : body.kind && body.kind in KIND ? (body.kind as NoticeKind) : null;
  const kind: NoticeKind = given ?? (body.group === true ? (/提醒/.test(title) ? 'remind' : 'post')
    : /退回|不同意|未通过/.test(title) ? 'back' : /^待|待(同意|核对|审|确认|办|答复|接收|决定)/.test(title) ? 'todo' : /提醒|截止|逾期/.test(title) ? 'remind'
    : /已成立|已同意|已通过|已批准|已认定/.test(title) ? 'pass' : /待同意|待核对|待审|待确认|待办|待答复|派了任务/.test(bare) ? 'todo' : 'fyi');
  const act = kind === 'todo' || kind === 'remind' || kind === 'back';
  const tag = typeof body.tag === 'string' && body.tag.trim() ? body.tag.trim().slice(0, 12) : KIND[kind].tag;
  const sub = [rule && rule[1] !== title ? rule[1] : '', body.at ?? ''].filter(Boolean).join(' · ') || '正则';
  return { kind, title, tag, sub, fields, text: rest || undefined, all: body.all === true, done,
    act: !done && kind === 'todo' && body.act?.kind === 'unit_consent' ? 'unit_consent' : null,
    btn: { text: own && body.btn ? String(body.btn).slice(0, 12) : act ? '前往办理' : '前往查看', type: KIND[kind].btn, url: inFeishu(own ?? `${origin}/#${rule ? rule[2] : '/'}`, origin, appId) },
    note: ['正则', body.by ? `经办：${body.by}` : ''].filter(Boolean).join(' · ') };
}
// 卡片：不用飞书自带的标题栏（只有固定颜色），顶上一条自定义底色的分栏当顶栏。来自业务的文字一律按纯文本放，不当作标记解析
// actToken：这条通知的办理凭据。有它、且通知带着能办的动作时，卡片上放「同意」按钮；没有时只放去页面的按钮
export function noticeCard(body: NoticeBody, origin: string, appId?: string, marks?: { red?: string; white?: string }, actToken?: string) {
  const v = noticeView(body, origin, appId), k = KIND[v.kind];
  const plain = (content: string, text_color: string, text_size = 'normal') => ({ tag: 'div', text: { tag: 'plain_text', content, text_color, text_size } });
  const col = (elements: unknown[], extra: object = {}) => ({ tag: 'column', width: 'weighted', weight: 1, vertical_align: 'top', elements, ...extra });
  const row = (columns: unknown[], extra: object = {}) => ({ tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', columns, ...extra });
  const col2 = (a: unknown, b: unknown) => row([col([a, b], { vertical_spacing: '2px' })]);
  const mark = k.white ? marks?.white : marks?.red;
  const bar = row([
    ...(mark ? [{ tag: 'column', width: 'auto', vertical_align: 'center', padding: '12px 0px 12px 16px', elements: [{ tag: 'img', img_key: mark, alt: { tag: 'plain_text', content: '正则' }, scale_type: 'crop_center', size: '32px 32px', corner_radius: '9px' }] }] : []),
    col([plain(v.title, k.title, 'heading'), plain(v.sub, k.sub, 'notation')], { vertical_align: 'center', vertical_spacing: '0px', padding: mark ? '12px 0px 12px 0px' : '12px 0px 12px 16px' }),
    { tag: 'column', width: 'auto', vertical_align: 'center', padding: '12px 16px 12px 0px', elements: [plain(v.tag, k.tagColor, 'notation')] },
  ], { background_style: k.bar, horizontal_spacing: '10px' });
  const main: unknown[] = [];
  if (v.all) main.push({ tag: 'markdown', content: '<at id=all></at>' });
  const kv = ([name, value]: [string, string]) => col([plain(name, 'zz-mute', 'notation'), plain(value, 'zz-ink')], { vertical_spacing: '2px' });
  // 分项两个一行；长的独占一行
  for (let i = 0; i < v.fields.length;) {
    const a = v.fields[i], b = v.fields[i + 1];
    if (b && a[1].length <= 14 && b[1].length <= 14) { main.push(row([kv(a), kv(b)])); i += 2; } else { main.push(row([kv(a)])); i += 1; }
  }
  // 分段的长通知（双周表通报、更新说明）：小标题下面逐条列，长的折叠起来
  const lines = (v.text ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
  const isHead = (x: string) => /^(已登记|未登记|连续两期及以上未登记|新增|调整|修复|说明)$/.test(x);
  const cut = lines.findIndex(isHead);
  const fold = (title: string, text: string, expanded = false) => ({ tag: 'collapsible_panel', expanded, border: { color: 'zz-line', corner_radius: '8px' }, vertical_spacing: '8px', padding: '8px 12px 8px 12px',
    header: { title: { tag: 'plain_text', content: title }, vertical_align: 'center', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' }, icon_position: 'right', icon_expanded_angle: -180 }, elements: [plain(text, 'zz-ink')] });
  if (v.text && cut >= 0 && (v.kind === 'post' || v.kind === 'remind')) {
    const lead = lines.slice(0, cut).join('\n'), secs: { h: string; items: string[] }[] = [];
    for (const x of lines.slice(cut)) { if (isHead(x)) secs.push({ h: x, items: [] }); else secs[secs.length - 1].items.push(x); }
    const st = v.text.match(/应登记 (\d+) 个研究单元，已登记 (\d+) 个，未登记 (\d+) 个/);
    if (st) {
      // 双周表：三个数并排，一条进度
      const [total, okN, noN] = [Number(st[1]), Number(st[2]), Number(st[3])], on = total > 0 ? Math.round((okN / total) * 20) : 0;
      const num = (name: string, value: string, color: string) => col([plain(name, 'zz-mute', 'notation'), plain(value, color, 'heading')], { vertical_spacing: '2px' });
      main.push(row([num('应登记', String(total), 'zz-ink'), num('已登记', String(okN), 'zz-brand'), num('未登记', String(noN), 'zz-ink')]));
      main.push({ tag: 'markdown', content: `<font color='zz-brand'>${'━'.repeat(on)}</font><font color='zz-track'>${'━'.repeat(20 - on)}</font>  <font color='zz-mute'>${total > 0 ? Math.round((okN / total) * 100) : 0}%</font>` });
    }
    // 带数字的通报：第一句已经画成数字了，用小字带过；后面的话是要人看的，照常显示
    if (lead && st) { const [first, ...more] = lines.slice(0, cut); main.push(plain(first, 'zz-mute', 'notation')); if (more.length) main.push(plain(more.join('\n'), 'zz-ink')); }
    else if (lead) main.push(plain(lead, 'zz-ink'));
    if (secs.some((x) => /登记/.test(x.h))) {
      // 名单一律折叠；截止前的提醒把未登记的展开
      for (const x of secs) if (x.items.length) main.push(fold(`${x.h}（${x.items.length}）`, x.items.join('\n'), v.kind === 'remind' && x.h === '未登记'));
    } else {
      // 更新说明：先露出前四条，其余折叠
      let room = 4; const more: string[] = [];
      for (const x of secs) {
        const show = x.items.slice(0, room), rest2 = x.items.slice(show.length); room -= show.length;
        if (show.length) main.push(col2(plain(x.h, 'zz-mute', 'notation'), plain(show.join('\n'), 'zz-ink')));
        if (rest2.length) more.push(x.h, ...rest2);
      }
      const n = more.filter((x) => !isHead(x)).length;
      if (n) main.push(fold(`其余 ${n} 条，点开查看`, more.join('\n')));
    }
  } else if (v.text) main.push(v.kind === 'back'
    ? { tag: 'interactive_container', width: 'fill', height: 'auto', corner_radius: '10px', padding: '9px 14px 9px 14px', background_style: 'zz-bad-bg', has_border: true, border_color: 'zz-bad', behaviors: [], elements: [plain(v.text, 'zz-bad')] }
    : plain(v.text, 'zz-ink'));
  // 通报带的图：图在正文下面，图下一行小字说明（来源等）。图先由定时任务传到飞书换成 img_key
  if (body.img_key) { main.push({ tag: 'img', img_key: body.img_key, alt: { tag: 'plain_text', content: body.img_note ?? '' }, scale_type: 'fit_horizontal', preview: true, corner_radius: '8px' });
    if (body.img_note) main.push(plain(body.img_note, 'zz-mute', 'notation')); }
  const button = (text: string, type: string, behaviors: unknown[], extra: object = {}) => ({ tag: 'button', text: { tag: 'plain_text', content: text }, type, size: 'medium', width: 'fill', behaviors, ...extra });
  const open = [{ type: 'open_url', default_url: v.btn.url }];
  if (v.done) main.push({ tag: 'interactive_container', width: 'fill', height: 'auto', corner_radius: '10px', padding: '9px 14px 9px 14px', background_style: 'zz-ok-bg', has_border: true, border_color: 'zz-ok', behaviors: [], elements: [plain(v.done, 'zz-ok')] });
  if (v.act && actToken) main.push(row([
    col([button('同意', 'default', [{ type: 'callback', value: { t: actToken, r: marks?.red ?? '', w: marks?.white ?? '' } }],
      { confirm: { title: { tag: 'plain_text', content: '同意这份申请？' }, text: { tag: 'plain_text', content: '同意后转给助理对照联席会议纪要核对。' } } })]),
    col([button('退回', 'danger_text', open)]) ]));
  else main.push(button(v.done ? '查看' : v.btn.text, v.done ? 'text' : v.btn.type, open));
  main.push(plain(v.note, 'zz-mute', 'notation'));
  return { title: v.title, view: v, card: { schema: '2.0', config: { update_multi: true, style: { color: CARD_COLORS }, summary: { content: v.title } },
    body: { padding: '0px 0px 0px 0px', vertical_spacing: '0px', elements: [bar, row([col(main, { padding: '14px 16px 14px 16px', vertical_spacing: '12px' })])] } } };
}

// ---------- 读视图、调函数：页面接口和 MCP 接口共用 ----------
// run：以某人的身份执行一条带参数的语句。线上走 Hyperdrive；测试里换成内存数据库。
export type Run = (uid: string | null, text: string, params: unknown[]) => Promise<any[]>;
const pgRun = (env: Env): Run => (uid, text, params) => withUser(env, uid, (sql) => sql.unsafe(text, params as any)).then((r) => fixArrays(r as any));
async function readView(run: Run, uid: string, view: string, filters: [string, string][], limit = 2000) {
  const where = filters.map(([k], i) => `${k}::text = $${i + 1}`).join(' and ');
  return run(uid, `select * from api.${view}${where ? ' where ' + where : ''} limit ${Math.max(1, Math.min(2000, Math.floor(limit) || 2000))}`, filters.map(([, v]) => v));
}
async function callRpc(run: Run, uid: string, fn: string, body: Record<string, unknown>) {
  const spec = RPC[fn];
  const args = spec.map(([name, type]) => {
    const v = body[name];
    if (v === undefined || v === null || v === '') return null;
    if (type === 'jsonb') return JSON.stringify(v);
    // 数组按 Postgres 的数组文本写：{"a","b"}
    if (type.endsWith('[]')) return `{${(Array.isArray(v) ? v : String(v).split(',').filter(Boolean)).map((x) => `"${String(x).replace(/["\\]/g, '\\$&')}"`).join(',')}}`;
    return String(v);
  });
  // 所有参数一律先按文本收、再转成目标类型。直接写 ::jsonb 或 ::boolean 时，驱动会按目标类型把已是文本的值再编码一次：
  // JSON 字符串被再编码成一个字符串；文本 'true' 被布尔编码器当成“不是 true”而写成 false
  const call = `select public.${fn}(${spec.map(([, type], i) => `$${i + 1}::text::${type}`).join(', ')}) as result`;
  const [row] = await run(uid, call, args);
  return row?.result ?? null;
}

// ---------- 访问令牌 ----------
export async function sha256hex(s: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const TOKEN_RE = /^clain_[A-Za-z0-9_-]{43}$/;
export const newToken = () => 'clain_' + b64u(crypto.getRandomValues(new Uint8Array(32)));

// ---------- MCP：后台的全部视图和函数，以令牌持有人的身份开放给智能体 ----------
// 无状态的 Streamable HTTP：每个 POST 一条 JSON-RPC 消息，直接回 JSON，不开 SSE。
// 工具只有五个，视图和函数的名字作为参数传：九十多个视图、一百三十多个函数逐个列成工具，客户端装不下。
// 密钥的保存和取用（/api/secret）不经 MCP 开放。
const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const str = { type: 'string' } as const;
export const MCP_TOOLS = [
  { name: 'whoami', description: '当前令牌持有人的姓名、角色和权限。先调这个确认身份。', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_views', description: '列出可读的全部视图及其列。视图是只读的查询，例如 project（课题和研究单元）、budget_line（预算行）、request（支出申请）、card（经费卡）。可用 keyword 按名称筛选。',
    inputSchema: { type: 'object', properties: { keyword: { ...str, description: '视图名里包含的字样，可省略' } } } },
  { name: 'read_view', description: '读一个视图的行。只能看到令牌持有人本人有权看到的数据。filters 按列做等值筛选，最多返回 2000 行。',
    inputSchema: { type: 'object', required: ['view'], properties: { view: { ...str, description: '视图名，见 list_views' },
      filters: { type: 'object', description: '列名 → 值，等值筛选', additionalProperties: { type: 'string' } }, limit: { type: 'number', description: '最多返回的行数，默认 200，上限 2000' } } } },
  { name: 'list_actions', description: '列出可调用的全部操作（数据库函数）及其参数名和类型。操作会改动数据，例如提交支出申请、登记两周时间去向。可用 keyword 按名称筛选。',
    inputSchema: { type: 'object', properties: { keyword: { ...str, description: '操作名里包含的字样，可省略' } } } },
  { name: 'call_action', description: '调用一个操作，会改动生产数据，以令牌持有人的身份执行，各项权限和业务检查照常生效。需要可写的令牌。调用前先向使用者确认。',
    inputSchema: { type: 'object', required: ['action', 'args'], properties: { action: { ...str, description: '操作名，见 list_actions' }, args: { type: 'object', description: '参数名 → 值' } } } },
];
const MCP_HINT = 'CLAIN 中台的后台接口。先用 whoami 确认身份；list_views / read_view 查数据；list_actions / call_action 办理业务。四个基本对象：项目（学校一侧的经费）、经费卡、课题、研究单元。支出一律先申请。call_action 会改动生产数据，调用前先向使用者确认。';
const rpcErr = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const bizError = (e: any) => (e?.code === '42501' || e?.code === 'P0001' ? String(e.message) : typeof e?.code === 'string' && /^(22|23)/.test(e.code) ? '数据不合法' : null);

async function mcpTool(run: Run, who: { token_id: string; user_id: string; can_write: boolean }, name: string, a: Record<string, any>) {
  const uid = who.user_id, kw = typeof a.keyword === 'string' ? a.keyword.toLowerCase() : '';
  if (name === 'whoami') { const [me] = await readView(run, uid, 'me', []); return { ...me, token_can_write: who.can_write }; }
  if (name === 'list_views') {
    const names = [...VIEWS].filter((v) => !kw || v.includes(kw)).sort();
    const cols = await run(uid, `select table_name as v, column_name as c, data_type as t from information_schema.columns where table_schema = 'api' order by table_name, ordinal_position`, []);
    return names.map((v) => ({ view: v, columns: (cols as any[]).filter((x) => x.v === v).map((x) => `${x.c}:${x.t}`) }));
  }
  if (name === 'read_view') {
    if (typeof a.view !== 'string' || !VIEWS.has(a.view)) throw new Error('没有这个视图，请先用 list_views 查看');
    const filters = Object.entries(a.filters ?? {}).filter(([k]) => /^[a-z_]+$/.test(k)).map(([k, v]): [string, string] => [k, String(v)]);
    const rows = await readView(run, uid, a.view, filters, typeof a.limit === 'number' ? a.limit : 200);
    return { rows, count: rows.length };
  }
  if (name === 'list_actions') return Object.entries(RPC).filter(([k]) => !kw || k.includes(kw)).sort(([x], [y]) => x.localeCompare(y)).map(([k, spec]) => ({ action: k, params: spec.map(([n, t]) => `${n}:${t}`) }));
  if (name === 'call_action') {
    if (typeof a.action !== 'string' || !RPC[a.action]) throw new Error('没有这个操作，请先用 list_actions 查看');
    if (!who.can_write) throw new Error('这个令牌是只读的，不能调用操作。需要办理业务请在中台另建一个可写的令牌');
    const log = (ok: boolean, error: string | null) => run(uid, `select public.log_api_call($1::text::uuid, $2::text, $3::text::boolean, $4::text)`, [who.token_id, a.action, String(ok), error]).catch(() => null);
    try { const result = await callRpc(run, uid, a.action, (a.args ?? {}) as Record<string, unknown>); await log(true, null); return { result }; }
    catch (e: any) { await log(false, bizError(e) ?? '服务器错误'); throw e; }
  }
  throw new Error('没有这个工具');
}

export async function mcp(req: Request, run: Run): Promise<Response> {
  if (req.method !== 'POST') return json({ error: '只接受 POST' }, 405, { allow: 'POST' });
  const bearer = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';
  const deny = () => json(rpcErr(null, -32001, '令牌无效、已停用或已过期'), 401, { 'www-authenticate': 'Bearer' });
  if (!TOKEN_RE.test(bearer)) return deny();
  const hash = await sha256hex(bearer);
  const [who] = await run(null, `select token_id, user_id, can_write from public.api_token_login($1::text)`, [hash]);
  if (!who) return deny();
  const msg = (await req.json().catch(() => null)) as any;
  if (!msg || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return json(rpcErr(msg?.id, -32600, '请求格式有误'), 400);
  if (msg.id === undefined) return new Response(null, { status: 202 });   // 通知，不需要回
  const done = (result: unknown) => json({ jsonrpc: '2.0', id: msg.id, result });
  if (msg.method === 'initialize') return done({ protocolVersion: MCP_VERSIONS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : MCP_VERSIONS[0],
    capabilities: { tools: {} }, serverInfo: { name: 'clain-portal', version: '1.0.0' }, instructions: MCP_HINT });
  if (msg.method === 'ping') return done({});
  if (msg.method === 'tools/list') return done({ tools: MCP_TOOLS });
  if (msg.method === 'tools/call') {
    const text = (v: unknown, isError = false) => done({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }], isError });
    try { return text(await mcpTool(run, who, String(msg.params?.name ?? ''), (msg.params?.arguments ?? {}) as Record<string, any>)); }
    catch (e: any) { const b = bizError(e); if (!b && e?.code) console.error(e); return text(b ?? (e?.code ? '服务器错误' : String(e?.message ?? e)), true); }
  }
  return json(rpcErr(msg.id, -32601, '不支持的方法'));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/mcp') return mcp(req, pgRun(env)).catch((e) => { console.error(e); return json(rpcErr(null, -32603, '服务器错误'), 500); });
    const appOrigin = env.APP_ORIGIN || url.origin;
    const cors = {
      'access-control-allow-origin': appOrigin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      vary: 'origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const redirectUri = `${url.origin}/auth/feishu/callback`;
    const jar = cookies(req);

    try {
      // ---------- 飞书登录 ----------
      if (url.pathname === '/auth/feishu/login') {
        const state = b64u(crypto.getRandomValues(new Uint8Array(16)));
        const to = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
        to.searchParams.set('client_id', env.FEISHU_APP_ID);
        to.searchParams.set('redirect_uri', redirectUri);
        to.searchParams.set('response_type', 'code');
        to.searchParams.set('state', state);
        const h = new Headers({ location: to.toString() });
        h.append('set-cookie', setCookie('fp_state', await sign(env.SESSION_SECRET, 'state', state, 600), 600));
        h.append('set-cookie', setCookie('fp_to', await sign(env.SESSION_SECRET, 'to', safeTo(url.searchParams.get('to')), 600), 600));
        return new Response(null, { status: 302, headers: h });
      }

      if (url.pathname === '/auth/feishu/callback') {
        const state = await verify(env.SESSION_SECRET, 'state', jar.fp_state);
        const code = url.searchParams.get('code');
        if (!state || !code || state !== url.searchParams.get('state')) return json({ error: '登录状态无效，请重新登录' }, 400);
        const tok = await feishu('/authen/v2/oauth/token', {
          method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ grant_type: 'authorization_code', client_id: env.FEISHU_APP_ID,
            client_secret: env.FEISHU_APP_SECRET, code, redirect_uri: redirectUri }) });
        if (!tok.access_token) return json({ error: '飞书授权失败' }, 401);
        const info = await feishu('/authen/v1/user_info', { headers: { authorization: `Bearer ${tok.access_token}` } });
        const u = info?.data;
        if (info?.code !== 0 || !u?.open_id) return json({ error: '读取飞书身份失败' }, 401);
        if (env.FEISHU_TENANT_KEY && u.tenant_key !== env.FEISHU_TENANT_KEY) return json({ error: '仅限本单位飞书账号登录' }, 403);
        const [row] = await withUser(env, null, (sql) =>
          sql`select id, active from login_feishu(${u.open_id}, ${u.name ?? ''}, ${u.enterprise_email || u.email || null}, ${u.union_id ?? null})`);
        // 账号未启用：没有人员档案的新面孔待人事确认，或者已停用。不发会话，回到登录页说明
        if (!row.active) return new Response(null, { status: 302, headers: { location: `${appOrigin}/?wait=1`, 'set-cookie': setCookie('fp_state', '', 0) } });
        const back = safeTo(await verify(env.SESSION_SECRET, 'to', jar.fp_to));
        const headers = new Headers({ location: back === '/' ? appOrigin : `${appOrigin}/#${back}` });
        headers.append('set-cookie', setCookie('fp_session', await sign(env.SESSION_SECRET, 'uid', row.id, SESSION_TTL), SESSION_TTL));
        headers.append('set-cookie', setCookie('fp_to', '', 0));
        headers.append('set-cookie', setCookie('fp_state', '', 0));
        return new Response(null, { status: 302, headers });
      }

      if (url.pathname === '/auth/logout' && req.method === 'POST')
        return json({ ok: true }, 200, { ...cors, 'set-cookie': setCookie('fp_session', '', 0) });

      // ---------- GitHub 事件：校验签名后入队，由定时任务发到协助群 ----------
      if (url.pathname === '/github/webhook' && req.method === 'POST') {
        if (!env.GITHUB_WEBHOOK_SECRET) return json({ error: '未配置' }, 404);
        const raw = await req.text();
        if (raw.length > 2_000_000 || !(await githubSigned(env.GITHUB_WEBHOOK_SECRET, raw, req.headers.get('x-hub-signature-256')))) return json({ error: '签名不对' }, 401);
        const event = req.headers.get('x-github-event') ?? '', delivery = (req.headers.get('x-github-delivery') ?? '').slice(0, 80);
        if (event === 'ping') return json({ ok: true });
        let p: unknown; try { p = JSON.parse(raw); } catch { return json({ error: '格式不对' }, 400); }
        const n = githubText(event, p);
        if (!n || !delivery) return json({ ok: true, skipped: true });
        const [r] = await withUser(env, null, (sql) => sql`select public.github_notice(${delivery}, ${n.text}, ${n.url}, ${n.btn}, ${n.thread}) as queued`);
        return json({ ok: true, queued: r.queued });
      }

      // 连通性检查：只确认接口层连得上数据库，不返回任何数据
      if (url.pathname === '/health') {
        const [r] = await withUser(env, null, (sql) => sql`select current_user as role, (select count(*) from api.me)::int as me`);
        return json({ ok: r.role === 'app_api' && r.me === 0 });
      }

      // ---------- 飞书卡片上的点击 ----------
      // 凭据是发卡片时签的，绑定那一条通知；点的人必须就是那条通知的收件人（卡片被转发给别人，别人点了不算）
      if (url.pathname === '/feishu/card' && req.method === 'POST') {
        const b = (await req.json().catch(() => null)) as any;
        if (!b) return json({ error: 'bad request' }, 400);
        if (env.FEISHU_VERIFICATION_TOKEN && (b.token ?? b.header?.token) !== env.FEISHU_VERIFICATION_TOKEN) return json({ error: 'forbidden' }, 403);
        if (b.type === 'url_verification') return json({ challenge: String(b.challenge ?? '') });
        const toast = (type: string, content: string, card?: unknown) => json({ toast: { type, content }, ...(card ? { card: { type: 'raw', data: card } } : {}) });
        const ev = b.event ?? {}, val = ev.action?.value ?? {};
        if (b.header?.event_type !== 'card.action.trigger') return json({});
        if (env.FEISHU_TENANT_KEY && ev.operator?.tenant_key !== env.FEISHU_TENANT_KEY) return toast('error', '仅限本单位飞书账号办理');
        const msg = await verify(env.SESSION_SECRET, 'act', typeof val.t === 'string' ? val.t : undefined);
        if (!msg || !/^\d+$/.test(msg)) return toast('error', '这张卡片已过期，请到正则里办理');
        const [o] = await withUser(env, null, (sql) => sql`select user_id, target_id, body from public.outbox_act(${msg}::bigint)`);
        const body = o ? (typeof o.body === 'string' ? JSON.parse(o.body) : o.body) : null;
        if (!o || !body?.act) return toast('error', '找不到这条通知，请到正则里办理');
        if (![ev.operator?.union_id, ev.operator?.open_id].filter(Boolean).includes(String(o.target_id))) return toast('error', '这张卡片不是发给你的，不能代办');
        if (body.act.kind !== 'unit_consent' || !/^[0-9a-f-]{36}$/.test(String(body.act.unit ?? ''))) return toast('error', '这张卡片上的事项不能在这里办，请到正则里办理');
        try {
          await withUser(env, String(o.user_id), (sql) => sql`select public.approve_unit(${String(body.act.unit)}::uuid)`);
        } catch (e: any) {
          return toast('info', String(e?.message ?? '没有办成，请到正则里办理').slice(0, 80));
        }
        const at = new Date(Date.now() + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
        const key = (x: unknown) => (typeof x === 'string' && /^[\w-]{8,80}$/.test(x) ? x : undefined);
        return toast('success', '已同意', noticeCard({ ...body, done: `你已同意 · ${at}` }, env.NOTICE_ORIGIN || 'https://clain-finance.pages.dev', env.FEISHU_APP_ID, { red: key(val.r), white: key(val.w) }).card);
      }

      // ---------- API ----------
      if (!url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
      const uid = await verify(env.SESSION_SECRET, 'uid', jar.fp_session);
      if (!uid) return json({ error: '未登录' }, 401, cors);

      const view = url.pathname.match(/^\/api\/v\/([a-z_]+)$/)?.[1];
      if (view && req.method === 'GET') {
        if (!VIEWS.has(view)) return json({ error: 'not found' }, 404, cors);
        const filters = [...url.searchParams].filter(([k]) => /^[a-z_]+$/.test(k));
        const rows = await readView(pgRun(env), uid, view, filters);
        // 页面每次打开都先读本人信息：读到了就把会话顺延
        const renew = view === 'me' && Array.isArray(rows) && rows.length > 0;
        return json(rows, 200, renew ? { ...cors, 'set-cookie': setCookie('fp_session', await sign(env.SESSION_SECRET, 'uid', uid, SESSION_TTL), SESSION_TTL) } : cors);
      }

      const fn = url.pathname.match(/^\/api\/rpc\/([a-z_]+)$/)?.[1];
      if (fn && req.method === 'POST') {
        const spec = RPC[fn];
        if (!spec) return json({ error: 'not found' }, 404, cors);
        // 写操作只接受来自前端页面的请求
        if (req.headers.get('origin') !== appOrigin) return json({ error: '来源不允许' }, 403, cors);
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        return json({ result: await callRpc(pgRun(env), uid, fn, body) }, 200, cors);
      }
      // 接口目录：全部视图及其列、全部操作及其参数，供「智能体接入」页的接口文档使用。只有名称和类型，不含数据
      if (url.pathname === '/api/meta' && req.method === 'GET') {
        const cols = await pgRun(env)(uid, `select table_name as v, column_name as c, data_type as t from information_schema.columns where table_schema = 'api' order by table_name, ordinal_position`, []);
        return json({ tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
          views: [...VIEWS].sort().map((v) => ({ view: v, columns: cols.filter((x) => x.v === v).map((x) => `${x.c}:${x.t}`) })),
          actions: Object.entries(RPC).sort(([x], [y]) => x.localeCompare(y)).map(([k, spec]) => ({ action: k, params: spec.map(([n, t]) => `${n}:${t}`) })) }, 200, cors);
      }
      // 访问令牌：明文在这里生成，只在这一次返回；数据库里只存哈希和末四位
      if (url.pathname === '/api/token/create' && req.method === 'POST') {
        if (req.headers.get('origin') !== appOrigin) return json({ error: '来源不允许' }, 403, cors);
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const token = newToken();
        await withUser(env, uid, async (sql) => sql`select public.create_api_token(${String(body.name ?? '')}::text, ${await sha256hex(token)}::text, ${token.slice(-4)}::text, ${String(body.write === true || body.write === 'true')}::text::boolean, ${String(Math.round(Number(body.days)) || 0)}::text::int)`);
        return json({ result: token }, 200, { ...cors, 'cache-control': 'no-store' });
      }
      // 密钥与账号：保存时加密，取用时解密；数据库里只有密文，每次取用都留记录
      const sec = url.pathname.match(/^\/api\/secret\/(set|get)$/)?.[1];
      if (sec && req.method === 'POST') {
        if (req.headers.get('origin') !== appOrigin) return json({ error: '来源不允许' }, 403, cors);
        if (!env.VAULT_KEY) return json({ error: '尚未配置加密口令，暂不可保存或查看密钥' }, 503, cors);
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const kind = String(body.kind ?? ''), id = String(body.id ?? '');
        if (!['resource', 'allocation'].includes(kind) || !/^[0-9a-f-]{36}$/.test(id)) return json({ error: '参数有误' }, 400, cors);
        const noStore = { ...cors, 'cache-control': 'no-store' };
        if (sec === 'set') {
          const plain = typeof body.secret === 'string' ? body.secret.trim() : '';
          if (plain.length > 2000) return json({ error: '内容过长' }, 400, cors);
          const cipher = plain ? await seal(env.VAULT_KEY, `${kind}:${id}`, plain) : null;
          await withUser(env, uid, (sql) => sql`select public.set_secret(${kind}::text, ${id}::uuid, ${cipher}::text, ${plain ? mask(plain) : null}::text)`);
          return json({ result: plain ? mask(plain) : null }, 200, noStore);
        }
        const [row] = await withUser(env, uid, (sql) => sql`select public.get_secret(${kind}::text, ${id}::uuid) as c`);
        return json({ result: await unseal(env.VAULT_KEY, `${kind}:${id}`, row.c) }, 200, noStore);
      }
      return json({ error: 'not found' }, 404, cors);
    } catch (e: any) {
      // 数据库函数抛出的业务错误（拦截原因、角色不符）原样返回给前端
      if (e?.code === '42501') return json({ error: e.message }, 403, cors);
      if (e?.code === 'P0001') return json({ error: e.message }, 400, cors);
      if (typeof e?.code === 'string' && /^(22|23)/.test(e.code)) return json({ error: '数据不合法' }, 400, cors);
      console.error(e);
      return json({ error: '服务器错误' }, 500, cors);
    }
  },

  // 定时把通知队列里的消息以应用身份发出：发给本人，或发到全员群（对象为 group）。每天十点以后顺带看当天有没有该发的双周表汇总。
  // 原说明：定时把通知队列里的消息以应用身份发给本人。开关 FEISHU_NOTIFY 不是 on 时什么都不做，也不连数据库。
  async scheduled(_event: unknown, env: Env): Promise<void> {
    if (env.FEISHU_NOTIFY !== 'on') return;
    if ((new Date().getUTCHours() + 8) % 24 >= 10) await withUser(env, null, (sql) => sql`select public.group_digest_tick()`).catch((e) => console.error(e));
    await biweeklyTasks(env).catch((e) => console.error('双周表任务', e));
    await withUser(env, null, (sql) => sql`select public.path_latch_tick()`).catch((e) => console.error('主线任务补记', e));
    await withUser(env, null, (sql) => sql`select public.coin_tick()`).catch((e) => console.error('实际币发放与到期', e));
    await withUser(env, null, (sql) => sql`select public.unit_stall_tick()`).catch((e) => console.error('研究单元停滞', e));
    await meetingSync(env).catch((e) => console.error('飞书会议同步', e));
    await transcriptSync(env).catch((e) => console.error('录音补漏', e));
    const batch = await withUser(env, null, (sql) => sql`select msg_id, target_id, body from public.outbox_take(20)`);
    if (!batch.length) return;
    const tok = await feishu('/auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: env.FEISHU_BOT_APP_ID || env.FEISHU_APP_ID, app_secret: env.FEISHU_BOT_APP_SECRET || env.FEISHU_APP_SECRET }) }).catch(() => null);
    const results: [string, boolean, string | null][] = [];
    let markNote: string | null = null;
    if (tok?.tenant_access_token) {
      for (const [k, png] of [['red', MARK_PNG], ['white', MARK_WHITE_PNG]] as const) {
        if (markKeys[k]) continue;
        const fd = new FormData(); fd.append('image_type', 'message');
        fd.append('image', new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: 'image/png' }), 'mark.png');
        const up = await feishu('/im/v1/images', { method: 'POST', headers: { authorization: `Bearer ${tok.tenant_access_token}` }, body: fd }).catch(() => null);
        if (up?.code === 0 && up.data?.image_key) markKeys[k] = String(up.data.image_key); else markNote = `标志图未传上去，卡片不带图。飞书返回 ${up?.code}：${String(up?.msg ?? '').slice(0, 120)}`;
      }
    }
    // 协助群里每个 PR 的话题：根消息是这个 PR 的第一条通报，库里按 pr:<编号> 记着
    const roots = new Map<string, string | null>();
    const rootOf = async (key: string) => {
      if (roots.has(key)) return roots.get(key) ?? null;
      const [row] = await withUser(env, null, (sql) => sql`select public.notice_thread(${key}) as id`).catch(() => [null]);
      roots.set(key, row?.id ? String(row.id) : null);
      return roots.get(key) ?? null;
    };
    const setRoot = async (key: string, id: string | null) => {
      roots.set(key, id);
      await withUser(env, null, (sql) => sql`select public.notice_thread_set(${key}, ${id ?? ''})`).catch(() => null);
    };
    for (const m of batch) {
      if (!tok?.tenant_access_token) { results.push([String(m.msg_id), false, '无法获取应用凭证']); continue; }
      const body = typeof m.body === 'string' ? JSON.parse(m.body) : m.body;
      const group = m.target_id === 'group' || m.target_id === 'assist';
      const to = m.target_id === 'group' ? env.NOTICE_CHAT_ID : m.target_id === 'assist' ? env.ASSIST_CHAT_ID : String(m.target_id);
      if (!to) { results.push([String(m.msg_id), false, m.target_id === 'assist' ? '未配置协助群' : '未配置全员群']); continue; }
      const direct = (msg_type: string, content: unknown) => feishu(`/im/v1/messages?receive_id_type=${group ? 'chat_id' : to.startsWith('on_') ? 'union_id' : 'open_id'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${tok.tenant_access_token}` },
        body: JSON.stringify({ receive_id: to, msg_type, content: JSON.stringify(content) }),
      }).catch((e) => ({ code: -1, msg: String(e?.message ?? e) }));
      // 协助群的 PR 通报：这个 PR 已有话题的，回复在话题里；还没有的，直接发到群里，这一条就是话题的根。
      // 根消息被撤回、删除的，清掉后把这一条当新的根
      const key = m.target_id === 'assist' && typeof body.thread === 'string' && /^pr:\d{1,7}$/.test(body.thread) ? body.thread : null;
      const send = async (msg_type: string, content: unknown) => {
        if (!key) return direct(msg_type, content);
        const root = await rootOf(key);
        if (root) {
          const r = await feishu(`/im/v1/messages/${encodeURIComponent(root)}/reply`, {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${tok.tenant_access_token}` },
            body: JSON.stringify({ msg_type, content: JSON.stringify(content), reply_in_thread: true }),
          }).catch((e) => ({ code: -1, msg: String(e?.message ?? e) }));
          if (r?.code === 0 || !/not exist|withdrawn|deleted|recall/i.test(String(r?.msg ?? ''))) return r;
          await setRoot(key, null);
        }
        const r = await direct(msg_type, content);
        if (r?.code === 0 && r.data?.message_id) await setRoot(key, String(r.data.message_id));
        return r;
      };
      // 先发卡片；卡片被拒的，退回发纯文字，通知不能因为版式丢掉
      const actToken = env.CARD_ACTIONS === '1' && !group && body.act ? await sign(env.SESSION_SECRET, 'act', String(m.msg_id), ACT_TTL) : undefined;
      // 带图的通报：先把图传上去；传不上去的照发文字，并记下原因
      if (body.img && !body.img_key) {
        const fd = new FormData(); fd.append('image_type', 'message');
        fd.append('image', new Blob([Uint8Array.from(atob(String(body.img)), (c) => c.charCodeAt(0))], { type: 'image/png' }), 'post.png');
        const up = await feishu('/im/v1/images', { method: 'POST', headers: { authorization: `Bearer ${tok.tenant_access_token}` }, body: fd }).catch(() => null);
        if (up?.code === 0 && up.data?.image_key) body.img_key = String(up.data.image_key); else markNote = `通报的图未传上去，卡片不带图。飞书返回 ${up?.code}：${String(up?.msg ?? '').slice(0, 120)}`;
      }
      let r = await send('interactive', noticeCard({ ...body, group }, env.NOTICE_ORIGIN || 'https://clain-finance.pages.dev', env.FEISHU_APP_ID, markKeys, actToken).card);
      const why = (x: any) => `飞书返回 ${x?.code}：${String(x?.msg ?? '').slice(0, 200)}`;
      let note: string | null = markNote;
      if (r?.code !== 0) { note = `卡片未发出，已改发文字。${why(r)}`; r = await send('text', { text: `${group && body.all === true ? '<at user_id="all">所有人</at> ' : ''}【正则】${body.text}` }); }
      results.push([String(m.msg_id), r?.code === 0, r?.code === 0 ? note : why(r)]);
    }
    await withUser(env, null, async (sql) => {
      for (const [id, ok, err] of results) await sql`select public.outbox_done(${id}::bigint, ${ok}::boolean, ${err}::text)`;
    });
  },
};
