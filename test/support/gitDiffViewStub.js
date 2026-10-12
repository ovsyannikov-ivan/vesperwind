import { defineComponent, h } from "vue";

export const DiffModeEnum = { Split: 1, Unified: 2 };
export const DiffView = defineComponent({
  props: ["data", "diffViewTheme", "diffViewMode"],
  setup: (props) => () =>
    h(
      "pre",
      {
        "data-diff-render": props.data.newFile.fileName,
        "data-diff-theme": props.diffViewTheme,
        "data-diff-mode": props.diffViewMode,
      },
      props.data.hunks[0],
    ),
});
