import 'reflect-metadata';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Posting } from './Posting.js';

/** Why the verification gate refused a code. */
export type RejectionReason =
  | 'not_iso_3166_1'
  | 'malformed'
  | 'duplicate'
  | 'confidence_out_of_range';

/**
 * A code the model proposed and the verification gate refused.
 *
 * Rejections are persisted rather than merely logged so that the failure mode is measurable.
 * A model that invents country codes should show up as rows here, not as silently wrong answers
 * in the eligibility query.
 */
@Entity({ name: 'rejected_code' })
@Index('idx_rejected_code_proposed', ['proposedCode'])
export class RejectedCode {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: string;

  @ManyToOne(() => Posting, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'posting_id' })
  posting!: Posting;

  @Column({ type: 'bigint', name: 'posting_id' })
  postingId!: string;

  /** Exactly what the model emitted, truncated but not cleaned up. */
  @Column({ type: 'varchar', length: 64, name: 'proposed_code' })
  proposedCode!: string;

  @Column({ type: 'varchar', length: 32 })
  reason!: RejectionReason;

  @Column({ type: 'text', name: 'raw_location_text' })
  rawLocationText!: string;

  @Column({ type: 'varchar', length: 128 })
  model!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
