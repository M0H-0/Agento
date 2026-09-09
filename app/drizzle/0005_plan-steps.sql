CREATE TABLE `plan_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`plan_version` integer DEFAULT 1 NOT NULL,
	`position` integer NOT NULL,
	`description` text NOT NULL,
	`tool` text,
	`risk_level` integer DEFAULT 0,
	`status` text DEFAULT 'pending' NOT NULL,
	`verification_score` real,
	`verified` integer,
	`missed_segments_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
