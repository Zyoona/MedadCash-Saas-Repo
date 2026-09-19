ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_action_check";
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_check" CHECK ("action" IN (
  'create','update','delete','login','logout','login_failed','view','search','export','print',
  'receive','reset_password','close_account','opening_balance','account_transfer','clear','bounce',
  'close','convert_to_variants','collection','supplier_payment','open_shift','close_shift',
  'renew','cancel','convert','backup','backup_failed','restore','bill','sync_push','sync_pull',
  'resolve_conflict','reverse'
));
