export type Layer = "observation" | "memory";

export type ProvenanceLink = {
  from_id: string;
  to_id: string;
  relation: "derived_from" | "supersedes" | "related_to";
};
