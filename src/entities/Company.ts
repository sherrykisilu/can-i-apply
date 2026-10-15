import 'reflect-metadata';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Posting } from './Posting.js';

/**
 * An employer. One row per company whose board is ingested.
 *
 * Companies are their own table rather than a text column on Posting because the same company
 * publishes hundreds of postings and because the board identifier (the Greenhouse board token,
 * for example) belongs to the company, not to each posting.
 */
@Entity({ name: 'company' })
export class Company {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: string;

  @Index('uq_company_slug', { unique: true })
  @Column({ type: 'varchar', length: 128 })
  slug!: string;

  @Column({ type: 'varchar', length: 256 })
  name!: string;

  /** The board this company's postings came from, for example 'greenhouse' or 'deel'. */
  @Column({ type: 'varchar', length: 64 })
  source!: string;

  @OneToMany('Posting', 'company')
  postings!: Posting[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
