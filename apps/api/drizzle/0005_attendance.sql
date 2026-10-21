CREATE TABLE "attendance_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"company_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"accuracy_m" double precision NOT NULL,
	"distance_m" double precision NOT NULL,
	"similarity" double precision,
	"real" boolean NOT NULL,
	"live" boolean NOT NULL,
	"status" text NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"late_min" integer DEFAULT 0 NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"evidence" "bytea"[],
	CONSTRAINT "attendance_entries_kind_check" CHECK ("attendance_entries"."kind" in ('check_in', 'check_out')),
	CONSTRAINT "attendance_entries_status_check" CHECK ("attendance_entries"."status" in ('recorded', 'pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "attendance_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"radius_m" integer NOT NULL,
	"start_time" text NOT NULL,
	"late_after_min" integer NOT NULL,
	"reminder_time" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	CONSTRAINT "attendance_settings_company_id_project_id_unique" UNIQUE("company_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "face_registrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"company_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"status" text NOT NULL,
	"template" "bytea" NOT NULL,
	"model_version" text NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	"photo" "bytea",
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "face_registrations_status_check" CHECK ("face_registrations"."status" in ('pending', 'approved', 'rejected', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "attendance_entries" ADD CONSTRAINT "attendance_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_entries" ADD CONSTRAINT "attendance_entries_membership_fk" FOREIGN KEY ("company_id","membership_id") REFERENCES "public"."memberships"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_entries" ADD CONSTRAINT "attendance_entries_project_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_settings" ADD CONSTRAINT "attendance_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_settings" ADD CONSTRAINT "attendance_settings_project_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_registrations" ADD CONSTRAINT "face_registrations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_registrations" ADD CONSTRAINT "face_registrations_membership_fk" FOREIGN KEY ("company_id","membership_id") REFERENCES "public"."memberships"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_entries_one_per_day" ON "attendance_entries" USING btree ("membership_id","work_date","kind") WHERE "attendance_entries"."status" <> 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX "face_registrations_one_approved" ON "face_registrations" USING btree ("membership_id") WHERE "face_registrations"."status" = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "face_registrations_one_pending" ON "face_registrations" USING btree ("membership_id") WHERE "face_registrations"."status" = 'pending';
--> statement-breakpoint
-- Backfill: grant the attendance capabilities to existing companies' system roles.
INSERT INTO "role_capabilities" ("id", "company_id", "role_id", "capability")
SELECT gen_random_uuid(), r."company_id", r."id", c."capability"
FROM "roles" r
JOIN (VALUES
  ('super_admin', 'attendance.approve_face'),
  ('super_admin', 'attendance.review'),
  ('super_admin', 'attendance.settings'),
  ('super_admin', 'attendance.export'),
  ('admin', 'attendance.approve_face'),
  ('admin', 'attendance.review'),
  ('admin', 'attendance.settings'),
  ('admin', 'attendance.export'),
  ('project_manager', 'attendance.approve_face'),
  ('project_manager', 'attendance.review'),
  ('coordinator', 'attendance.review')
) AS c("role_key", "capability") ON c."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT ("role_id", "capability") DO NOTHING;
