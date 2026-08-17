ALTER TABLE `sbl_knowledge_chunks`
  ADD CONSTRAINT `uq_kc_source_chunk`
  UNIQUE (`scope`, `ref_id`, `source_id`, `chunk_index`);
