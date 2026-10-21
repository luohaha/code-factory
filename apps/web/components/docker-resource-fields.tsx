'use client';

import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import type { DockerResources } from '@/lib/agent-manager-client';
import { useI18n } from '@/lib/i18n';

export function DockerResourceFields({ id, value, onChange, disabled = false, remote = false }: {
  id: string;
  value: DockerResources | null;
  onChange: (value: DockerResources | null) => void;
  disabled?: boolean;
  remote?: boolean;
}) {
  const { t } = useI18n();
  return <>
    <Field>
      <FieldLabel htmlFor={`${id}-isolation`}>{t('Resource isolation')}</FieldLabel>
      <NativeSelect id={`${id}-isolation`} className="w-full" value={value && !remote ? 'docker' : 'host'}
        disabled={disabled || remote} onChange={(event) => onChange(event.target.value === 'docker'
          ? { image: 'code-factory-agent:local', cpus: 2, memoryMb: 4096 } : null)}>
        <NativeSelectOption value="host">{t('Host (no resource limits)')}</NativeSelectOption>
        <NativeSelectOption value="docker">{t('Docker (CPU and memory limits)')}</NativeSelectOption>
      </NativeSelect>
      <FieldDescription>{t(remote ? 'Docker resource isolation is only available for local workspaces.'
        : 'Docker requires a prepared Linux agent image and host networking. Your home directory is shared read/write.')}</FieldDescription>
    </Field>
    {value && !remote ? <>
      <Field>
        <FieldLabel htmlFor={`${id}-image`}>{t('Docker image')}</FieldLabel>
        <Input id={`${id}-image`} required value={value.image} disabled={disabled}
          onChange={(event) => onChange({ ...value, image: event.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field>
          <FieldLabel htmlFor={`${id}-cpus`}>{t('CPU cores')}</FieldLabel>
          <Input id={`${id}-cpus`} type="number" min="0.01" max="1024" step="0.01" required value={value.cpus} disabled={disabled}
            onChange={(event) => onChange({ ...value, cpus: event.target.valueAsNumber })} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-memory`}>{t('Memory (MiB)')}</FieldLabel>
          <Input id={`${id}-memory`} type="number" min="64" max="1048576" step="1" required value={value.memoryMb} disabled={disabled}
            onChange={(event) => onChange({ ...value, memoryMb: event.target.valueAsNumber })} />
        </Field>
      </div>
    </> : null}
  </>;
}
