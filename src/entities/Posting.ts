import 'reflect-metadata';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Company } from './Company.js';
import type { PostingLocation } from './PostingLocation.js';

/** How far a posting has got through normalisation. */
export type NormalisationStatus = 'pending' | 'normalised' | 'failed';

/**
 * A single job posting as published by a board.
 *
 * rawLocationText is kept verbatim and is never overwritten. Every eligibility answer the system
 * gives can be traced back to the exact string a board published, which matters because the
 * normalisation step is the part most likely to be wrong.
 */
@Entity({ name: 'posting' })
@Index('uq_posting_source_external_id', ['source', 'externalId'], { unique: true })
export class Posting {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: string;

  @ManyToOne(() => Company, (company) => company.postings, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ type: 'bigint', name: 'company_id' })
  companyId!: string;

  /** Board the posting came from, for example 'greenhouse' or 'deel'. */
  @Column({ type: 'varchar', length: 64 })
  source!: string;

  /** The board's own identifier for the posting. Unique within a source. */
  @Column({ type: 'varchar', length: 128, name: 'external_id' })
  externalId!: string;

  @Column({ type: 'varchar', length: 512 })
  title!: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  department!: string | null;

  @Column({ type: 'text' })
  url!: string;

  /** The free text location eligibility string exactly as the board published it. */
  @Column({ type: 'text', name: 'raw_location_text' })
  rawLocationText!: string;

  @Column({
    type: 'varchar',
    length: 16,
    name: 'normalisation_status',
    default: 'pending',
  })
  normalisationStatus!: NormalisationStatus;

  /** Set when the gate rejected every code the model proposed, or the model returned nothing. */
  @Column({ type: 'text', name: 'normalisation_error', nullable: true })
  normalisationError!: string | null;

  @OneToMany('PostingLocation', 'posting')
  postingLocations!: PostingLocation[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
