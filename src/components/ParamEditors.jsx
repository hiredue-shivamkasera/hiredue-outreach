// The settings form for one step: a control per catalog param kind, including the structured kinds (output fields, conditions, follow-up sequences).
import { useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronsUpDown, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

// Radix Select cannot hold an empty value, but catalog options sometimes mean "none" with "".
const EMPTY = "__empty__";
const toSel = (v) => (v === "" || v === null || v === undefined ? EMPTY : String(v));
const fromSel = (v) => (v === EMPTY ? "" : v);

export function SimpleSelect({ value, onChange, options, placeholder, className, ...props }) {
  return (
    <Select value={toSel(value)} onValueChange={(v) => onChange(fromSel(v))}>
      <SelectTrigger className={cn("w-full", className)} {...props}><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {options.map(([v, l]) => <SelectItem key={toSel(v)} value={toSel(v)}>{l}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

const FIELD_TYPES = [["text", "Text"], ["number", "Number"], ["boolean", "Yes / no"], ["choice", "Choice"]];

function OutputFieldsEditor({ value, onChange }) {
  const rows = Array.isArray(value) ? value : [];
  const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="space-y-2 rounded-lg border bg-muted/30 p-2.5">
          <div className="flex gap-2">
            <Input className="h-8 flex-1 font-mono text-xs" value={r.name || ""} placeholder="name" onChange={(e) => set(i, { name: e.target.value.replace(/\s+/g, "_") })} />
            <SimpleSelect className="h-8 w-28 text-xs" value={r.type || "text"} options={FIELD_TYPES} onChange={(t) => set(i, { type: t })} />
            <Button variant="ghost" size="icon-sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} title="Remove field"><Trash2 /></Button>
          </div>
          {r.type === "choice" && <Input className="h-8 text-xs" value={r.choices || ""} placeholder="Choices, comma-separated: hot, warm, cold" onChange={(e) => set(i, { choices: e.target.value })} />}
          <Input className="h-8 text-xs" value={r.description || ""} placeholder="What the model should put here" onChange={(e) => set(i, { description: e.target.value })} />
        </div>
      ))}
      <Button variant="outline" size="sm" className="w-full border-dashed" onClick={() => onChange([...rows, { name: "", type: "text", description: "" }])}><Plus />Add field</Button>
    </div>
  );
}

const OPS = [["equals", "equals"], ["notEquals", "does not equal"], ["contains", "contains"], ["notContains", "does not contain"], ["greaterThan", "greater than"], ["lessThan", "less than"], ["atLeast", "at least"], ["atMost", "at most"], ["isTrue", "is true"], ["isFalse", "is false"], ["isEmpty", "is empty"], ["isNotEmpty", "is not empty"]];
const NO_VALUE = new Set(["isTrue", "isFalse", "isEmpty", "isNotEmpty"]);

function FieldCombobox({ value, onChange, suggestions }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const pick = (v) => { onChange(v); setOpen(false); setSearch(""); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" size="sm" className="h-8 w-full justify-between font-mono text-xs font-normal">
          <span className={cn("truncate", !value && "text-muted-foreground")}>{value || "field"}</span><ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Field, e.g. ai.score" value={search} onValueChange={setSearch} onKeyDown={(e) => { if (e.key === "Enter" && search && !suggestions.includes(search)) pick(search.trim()); }} />
          <CommandList>
            <CommandEmpty>{search ? <button className="w-full px-2 text-left text-xs" onClick={() => pick(search.trim())}>Use “{search.trim()}”</button> : "No fields"}</CommandEmpty>
            {search && !suggestions.includes(search.trim()) && <CommandGroup><CommandItem value={`__custom ${search}`} onSelect={() => pick(search.trim())}>Use “{search.trim()}”</CommandItem></CommandGroup>}
            <CommandGroup heading="Fields">
              {suggestions.map((s) => (
                <CommandItem key={s} value={s} onSelect={() => pick(s)} className="font-mono text-xs">
                  <Check className={cn("size-3.5", value === s ? "opacity-100" : "opacity-0")} />{s}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ConditionsEditor({ value, onChange, suggestions }) {
  const v = value && typeof value === "object" ? value : { match: "all", rules: [] };
  const rules = v.rules || [];
  const setRule = (i, patch) => onChange({ ...v, rules: rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        Pass when
        <ToggleGroup type="single" size="sm" variant="outline" value={v.match || "all"} onValueChange={(m) => m && onChange({ ...v, match: m })}>
          <ToggleGroupItem value="all" className="px-3 text-xs">all</ToggleGroupItem>
          <ToggleGroupItem value="any" className="px-3 text-xs">any</ToggleGroupItem>
        </ToggleGroup>
        rules match
      </div>
      {rules.map((r, i) => (
        <div key={i} className="space-y-2 rounded-lg border bg-muted/30 p-2.5">
          <div className="flex gap-2">
            <div className="min-w-0 flex-1"><FieldCombobox value={r.field} suggestions={suggestions} onChange={(f) => setRule(i, { field: f })} /></div>
            <Button variant="ghost" size="icon-sm" onClick={() => onChange({ ...v, rules: rules.filter((_, j) => j !== i) })} title="Remove rule"><Trash2 /></Button>
          </div>
          <div className="flex gap-2">
            <SimpleSelect className="h-8 w-40 shrink-0 text-xs" value={r.op || "equals"} options={OPS} onChange={(op) => setRule(i, { op, ...(NO_VALUE.has(op) ? { value: "" } : {}) })} />
            {!NO_VALUE.has(r.op || "equals") && <Input className="h-8 min-w-0 flex-1 text-xs" value={r.value ?? ""} placeholder="value" onChange={(e) => setRule(i, { value: e.target.value })} />}
          </div>
        </div>
      ))}
      <Button variant="outline" size="sm" className="w-full border-dashed" onClick={() => onChange({ ...v, rules: [...rules, { field: "", op: "equals", value: "" }] })}><Plus />Add rule</Button>
    </div>
  );
}

function SequenceEditor({ value, onChange }) {
  const steps = Array.isArray(value) ? value : [];
  const set = (i, patch) => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i, d) => { const next = [...steps]; [next[i], next[i + d]] = [next[i + d], next[i]]; onChange(next); };
  return (
    <div className="space-y-2">
      {steps.map((s, i) => (
        <div key={i} className="space-y-2 rounded-lg border bg-muted/30 p-2.5">
          <div className="flex items-center gap-2 text-xs">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">{i + 1}</span>
            <span className="text-muted-foreground">after</span>
            <Input type="number" min={0} className="h-7 w-16 text-xs" value={s.afterDays ?? ""} onChange={(e) => set(i, { afterDays: e.target.value === "" ? "" : Number(e.target.value) })} />
            <span className="text-muted-foreground">days</span>
            <span className="flex-1" />
            <Button variant="ghost" size="icon-xs" disabled={i === 0} onClick={() => move(i, -1)} title="Move up"><ArrowUp /></Button>
            <Button variant="ghost" size="icon-xs" disabled={i === steps.length - 1} onClick={() => move(i, 1)} title="Move down"><ArrowDown /></Button>
            <Button variant="ghost" size="icon-xs" onClick={() => onChange(steps.filter((_, j) => j !== i))} title="Remove message"><Trash2 /></Button>
          </div>
          <Textarea rows={3} className="text-xs" value={s.text || ""} placeholder="Hi {{firstName}}, …" onChange={(e) => set(i, { text: e.target.value })} />
        </div>
      ))}
      <Button variant="outline" size="sm" className="w-full border-dashed" onClick={() => onChange([...steps, { afterDays: 3, text: "" }])}><Plus />Add follow-up</Button>
    </div>
  );
}

const BASE_FIELDS = ["name", "headline", "location", "degree", "comment", "text", "authorName", "about", "experience", "evaluation.score", "evaluation.qualified", "draft"];

// Fields a condition can test: the usual item fields plus every output field of an AI prompt step upstream of this one.
export function fieldSuggestions(nodeId, nodes, edges) {
  const seen = new Set();
  const stack = [nodeId];
  const extra = [];
  while (stack.length) {
    const id = stack.pop();
    for (const e of edges) {
      if (e.target !== id || seen.has(e.source)) continue;
      seen.add(e.source);
      stack.push(e.source);
      const n = nodes.find((x) => x.id === e.source);
      const type = n?.data?.type ?? n?.type;
      const params = n?.data?.params ?? n?.params ?? {};
      if (type === "aiPrompt" && Array.isArray(params.outputFields)) for (const f of params.outputFields) if (f.name) extra.push(`${params.outputKey || "ai"}.${f.name}`);
    }
  }
  return [...new Set([...extra, ...BASE_FIELDS])];
}

export function ParamField({ p, value, onChange, suggestions = BASE_FIELDS }) {
  const id = `param-${p.key}`;
  let control;
  if (p.kind === "textarea") control = <Textarea id={id} rows={5} className="text-sm" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
  else if (p.kind === "number") control = <Input id={id} type="number" min={0} value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} />;
  else if (p.kind === "select") control = <SimpleSelect id={id} value={value ?? p.default} options={p.options || []} onChange={onChange} />;
  else if (p.kind === "outputFields") control = <OutputFieldsEditor value={value} onChange={onChange} />;
  else if (p.kind === "conditions") control = <ConditionsEditor value={value} onChange={onChange} suggestions={suggestions} />;
  else if (p.kind === "sequence") control = <SequenceEditor value={value} onChange={onChange} />;
  else control = <Input id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium leading-snug">{p.label}{p.required && <span className="text-destructive"> *</span>}</Label>
      {control}
      {p.help && <p className="text-xs text-muted-foreground">{p.help}</p>}
    </div>
  );
}
