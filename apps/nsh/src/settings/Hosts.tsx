import { NotYetHere, SectionPage, type SectionProps } from "./parts";

/**
 * Hosts: pairing, models, sharing, admins and host command grants, configuration, network access, extensions and
 * compaction, moving sessions between hosts. `id` opens one host.
 */
export function Hosts(_props: SectionProps) {
  return <SectionPage testID="settings-hosts"><NotYetHere what="Host settings" /></SectionPage>;
}
